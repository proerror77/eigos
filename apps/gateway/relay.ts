import { consentDeadline } from '../../packages/security/consent-lifetime.js';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Express, Request, RequestHandler } from 'express';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import type { Principal } from '../../packages/core/domain.js';
import { digest } from '../../packages/core/delegation.js';
import type { JobStore } from '../../packages/core/store.js';
import type { TaskRelayTasks,TaskRelayTransport,TaskRelayHostPort } from '../../packages/agent-transport/task-host.js';
import type { SourceReadRequest,SourceReadResponse } from '../../packages/agent-transport/service-contracts.js';
import {TaskSecurity} from '../../packages/security/task-service.js';
import {ownerKey} from '../../packages/core/domain.js';
import { verifyCard, verifyProof } from '../../packages/agent-transport/crypto.js';
import { TaskRelayHost } from '../../packages/agent-transport/task-host.js';
import { TASK_RELAY_PROTOCOL, taskRelayMetadataSchema } from '../../packages/agent-transport/task-contracts.js';
import { agentIdSchema, relayOrigin, RelayError } from '../../packages/relay/contracts.js';
import { SecurityError } from '../../packages/security/store.js';
import { sourceReadResponseSchema } from '../../packages/agent-transport/service-contracts.js';
import { RelayEnrollmentIssuer,type RelayEnrollmentAuthority } from '../../packages/agent-transport/enrollment.js';
import { readPrivateJson } from '../../packages/relay/files.js';

const relayConfigSchema = z.strictObject({
  version: z.literal(1), relayUrl: z.string().transform(relayOrigin),
  credentialPath: z.string().refine(isAbsolute), statePath: z.string().refine(isAbsolute).optional(),
  displayName: z.string().min(1).max(80).default('EIGOS'),
  enrollmentKeyFile: z.string().refine(isAbsolute).optional(),
  operatorInstallationId: z.uuid().optional(),
});
export function readTaskRelayConfig(path: string) {
  return relayConfigSchema.parse(readPrivateJson(path, 8192));
}
/** PG hosts inject a durable node; a legacy filesystem credential is then
 * unnecessary. The existing file reader retains its strict original schema. */
export type TaskRelayConfiguration=Omit<z.infer<typeof relayConfigSchema>,'credentialPath'>&{credentialPath?:string};

type Awaitable<T>=T|Promise<T>;
export interface TaskRelayGatewayPort extends TaskRelayHostPort {
  readonly gatewayOrigin:string;
  now():number;
  bindingAdmission(principal:Principal):Promise<{installationId:string;expiresAt:number}>;
  bind(principal:Principal,agentId:string,expiresAt:number,proof:{jti:string;expiresAt:number}):Awaitable<{agentId:string;installationId:string;expiresAt:number}>;
  revoke(principal:Principal,agentId:string):Awaitable<void>;
  consumeProof(proof:{jti:string;expiresAt:number}):Awaitable<void>;
  readonly enrollment:RelayEnrollmentAuthority;
  readonly reads:{
    pending():Awaitable<{peerId:string;request:SourceReadRequest}[]>;
    peer(id:string):Awaitable<string>;
    route(id:string,connectionId:string):Awaitable<void>;
    authorize(id:string,peerId?:string):Awaitable<SourceReadRequest>;
    authorizeProof(id:string,peerId:string,proof:{jti:string;expiresAt:number}):Awaitable<SourceReadRequest>;
    dispatched(id:string,connectionId:string):Awaitable<void>;
    accept(peerId:string,connectionId:string,input:SourceReadResponse):Awaitable<void>;
    revoke(id:string):Awaitable<void>;
  };
}
export function sqliteTaskRelayGatewayPort(store:JobStore):TaskRelayGatewayPort{
  if(!store.security.enabled||!store.authority)throw new Error('Task Relay requires the canonical primary authority');
  const projection=new TaskSecurity(store);
  return {authorityId:store.authority.id,gatewayOrigin:store.authority.canonicalOrigin,now:()=>store.security.now(),authorityCurrent:()=>store.authorityCurrent(),
    principal:id=>store.security.relay.principal(id),command:(id,request,hash)=>store.security.relay.command(id,request,hash),project:(p,id)=>projection.project(p,store.get(ownerKey(p),id)),
    bindingAdmission:async p=>{const actor=store.security.agentContext(p),parent=store.security.agentGrant(actor.installationId);return {installationId:actor.installationId,expiresAt:consentDeadline(parent.expiresAt)};},
    bind:(...args)=>store.security.relay.bind(...args),revoke:(...args)=>store.security.relay.revoke(...args),consumeProof:proof=>store.security.relay.consumeProof(proof),
    enrollment:{now:()=>store.security.now(),withEnrollmentAdmission:async(p,action)=>{const actor=store.security.agentContext(p),parent=store.security.agentGrant(actor.installationId);const result=await action({ownerKey:actor.ownerKey,installationId:actor.installationId,expiresAt:consentDeadline(parent.expiresAt)});store.security.agentContext(p);return result;}},
    reads:{pending:()=>store.security.relayReads.pending(),peer:id=>store.security.relayReads.peer(id),route:(id,connection)=>store.security.relayReads.route(id,connection),authorize:(id,peer)=>store.security.relayReads.authorize(id,peer),dispatched:(id,connection)=>store.security.relayReads.dispatched(id,connection),accept:(peer,connection,input)=>store.security.relayReads.accept(peer,connection,input),revoke:id=>store.security.relayReads.revoke(id),
      authorizeProof:(id,peer,proof)=>store.security.atomic(()=>{const request=store.security.relayReads.authorize(id,peer);store.security.relay.consumeProof(proof);return request;})},
  };
}

export class TaskRelayGateway {
  private client?: TaskRelayTransport;
  private readonly port:TaskRelayGatewayPort;
  private host?: TaskRelayHost;
  private abort = new AbortController();
  private running?: Promise<void>;
  private dispatching?: Promise<void>;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private active = new Set<Promise<unknown>>();
  private state: 'starting' | 'connected' | 'unavailable' | 'stopped' = 'starting';
  readonly enrollment?: RelayEnrollmentIssuer;
  constructor(store:JobStore|TaskRelayGatewayPort,private tasks:TaskRelayTasks,private gatewayOrigin:string,private config:TaskRelayConfiguration,private sourceAgentId?:string,private options:{openClient?:(config:TaskRelayConfiguration)=>Promise<TaskRelayTransport>;enrollmentKey?:ConstructorParameters<typeof RelayEnrollmentIssuer>[0]}={}){
    const sqlite='security'in store;this.port=sqlite?sqliteTaskRelayGatewayPort(store):store;
    if(!sqlite&&!options.openClient)throw new Error('The PostgreSQL Relay requires an explicit durable node transport');
    if(this.port.gatewayOrigin!==gatewayOrigin)throw new Error('Task Relay requires the canonical primary authority');
    const key=options.enrollmentKey??config.enrollmentKeyFile;
    if(key)this.enrollment=new RelayEnrollmentIssuer(key,gatewayOrigin,config.relayUrl,this.port.enrollment);
  }
  get status() { return this.state; }
  metadata() {
    if (this.closing) throw new SecurityError('AUTHORITY_UNAVAILABLE');
    return this.snapshotMetadata();
  }
  private snapshotMetadata() {
    if (!this.client) throw new SecurityError('AUTHORITY_UNAVAILABLE');
    return taskRelayMetadataSchema.parse({ protocol: TASK_RELAY_PROTOCOL, authorityId: this.port.authorityId,
      gatewayOrigin: this.gatewayOrigin, relayUrl: this.config.relayUrl, gatewayAgentId: this.client.agentId, bindingPath: '/relay/bind', ...(this.enrollment ? { enrollmentPath: '/relay/enrollment' } : {}) });
  }
  start(): Promise<void> {
    if (this.closing) return Promise.reject(new SecurityError('AUTHORITY_UNAVAILABLE'));
    return this.opening ??= this.open();
  }
  private track<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new SecurityError('AUTHORITY_UNAVAILABLE'));
    const work = Promise.resolve().then(action); this.active.add(work);
    void work.finally(() => this.active.delete(work)).catch(() => {});
    return work;
  }
  private async open() {
    if(this.options.openClient)this.client=await this.options.openClient(this.config);
    else{
      if(!this.config.credentialPath)throw new Error('The legacy Relay node requires its existing credential path');
      this.client=await (await import('../../packages/agent-transport/client.js')).RelayClient.open({baseUrl:this.config.relayUrl,credentialPath:this.config.credentialPath,statePath:this.config.statePath,displayName:this.config.displayName});
    }
    this.host = new TaskRelayHost(this.port, this.tasks, this.client, this.port.authorityId);
    this.running = this.run();
    this.dispatching = this.dispatch();
  }
  private async run() {
    while (!this.abort.signal.aborted) {
      try {
        await this.client!.peer(this.client!.agentId);
        if (this.sourceAgentId) {
          const contact = await this.client!.ensureContact(this.sourceAgentId);
          if (contact.state === 'pending' && contact.recipient === this.client!.agentId) await this.client!.respondContact(contact.id, 'accept');
        }
        this.state = 'connected';
        await this.client!.listen(async message => {
          const result = sourceReadResponseSchema.safeParse(message.content);
          if (!result.success) return this.host!.handle(message, this.abort.signal);
          try { await this.port.reads.accept(message.senderId, message.connectionId, result.data); }
          catch (error) { if (!(error instanceof SecurityError)) throw error; }
        }, this.abort.signal);
      } catch {
        if (this.abort.signal.aborted) break;
        this.state = 'unavailable';
        await delay(1000, undefined, { signal: this.abort.signal }).catch(() => {});
      }
    }
    this.state = 'stopped';
  }
  private async dispatch() {
    while (!this.abort.signal.aborted) {
      const pending=await this.port.reads.pending();
      for(let offset=0;offset<pending.length;offset+=2){
        await Promise.all(pending.slice(offset,offset+2).map(async({peerId,request})=>{
        if (this.abort.signal.aborted) return;
        try {
          const contact = (await this.client!.contacts()).find(c => c.state === 'accepted' && [c.requester, c.recipient].includes(peerId));
          if (!contact) return;
          await this.port.reads.route(request.callId, contact.id);
          const id = await this.client!.queue(peerId, contact.id, request, { id: request.callId, expiresAt: request.expiresAt });
          await this.client!.deliver(id, { signal: this.abort.signal, beforeSend: async () => { await this.port.reads.authorize(request.callId, peerId); } });
          await this.port.reads.dispatched(request.callId, contact.id);
        } catch (error) {
          if (error instanceof SecurityError) await this.port.reads.revoke(request.callId);
        }
        }));
      }
      await delay(100, undefined, { signal: this.abort.signal }).catch(() => {});
    }
  }
  async bind(principal: Principal, token: string, input: unknown, proof: string) {
    return this.track(() => this.bindStarted(principal, token, input, proof));
  }
  private async bindStarted(principal: Principal, token: string, input: unknown, proof: string) {
    if (!this.client || this.state !== 'connected') throw new SecurityError('AUTHORITY_UNAVAILABLE');
    const body = z.strictObject({ signedCard: z.string().max(4096) }).parse(input);
    const card = await verifyCard(body.signedCard), peer = await this.client.peer(card.card.agentId);
    if (peer.signedCard !== card.signedCard) throw new SecurityError('AUTHORIZATION_REQUIRED');
    const now = this.port.now();
    const checkedProof = await verifyProof(proof, token, 'POST', this.gatewayOrigin + '/relay/bind', card.card.agentId, now);
    const tokenExpiry = z.number().int().positive().parse(decodeJwt(token).exp) * 1000;
    const admission=await this.port.bindingAdmission(principal);
    const expiresAt=Math.min(tokenExpiry,now+900000,admission.expiresAt);
    const binding=await this.port.bind(principal,card.card.agentId,expiresAt,checkedProof);
    // Contact acceptance only follows this installation's authenticated key binding.
    let contact = await this.client.ensureContact(card.card.agentId);
    await this.port.principal(card.card.agentId);
    if (contact.state === 'pending' && contact.recipient === this.client.agentId) contact = await this.client.respondContact(contact.id, 'accept',async()=>{await this.port.principal(card.card.agentId);});
    await this.port.principal(card.card.agentId);
    return { ...binding, ...this.snapshotMetadata(), connectionId: contact.id };
  }
  async enroll(principal: Principal, token: string, input: unknown, proof: string) {
    return this.track(() => this.enrollStarted(principal, token, input, proof));
  }
  private async enrollStarted(principal: Principal, token: string, input: unknown, proof: string) {
    if (!this.enrollment) throw new SecurityError('AUTHORIZATION_REQUIRED');
    const { signedCard } = z.strictObject({ signedCard: z.string().max(4096) }).parse(input);
    const card = await verifyCard(signedCard);
    const checked = await verifyProof(proof, token, 'POST', this.gatewayOrigin + '/relay/enrollment', card.card.agentId, this.port.now());
    const result = await this.enrollment.issue(principal, token, card.card.agentId);
    await this.port.consumeProof(checked);
    await this.port.bindingAdmission(principal);if(result.expiresAt<=this.port.now())throw new SecurityError('AUTHORIZATION_REQUIRED');
    return result;
  }
  async enrollPrimary(principal: Principal, token: string, renewRequestId?: string) {
    return this.track(() => this.enrollPrimaryStarted(principal, token, renewRequestId));
  }
  private async enrollPrimaryStarted(principal: Principal, token: string, renewRequestId?: string) {
    if (!this.client || !this.enrollment || (await this.port.bindingAdmission(principal)).installationId !== this.config.operatorInstallationId) throw new SecurityError('AUTHORIZATION_REQUIRED');
    const assertion = await this.enrollment.issue(principal, token, this.client.agentId);
    return renewRequestId ? this.client.renew(assertion.accessToken, z.uuid().parse(renewRequestId)) : this.client.register(assertion.accessToken);
  }
  close(): Promise<void> {
    return this.closing ??= this.drain();
  }
  private async drain() {
    this.abort.abort();
    await this.opening?.catch(() => {});
    await Promise.allSettled([...this.active]);
    const stopped=await Promise.allSettled([this.running,this.dispatching]),errors:unknown[]=[];
    for(const result of stopped)if(result.status==='rejected')errors.push(result.reason);
    try{await this.client?.close();}catch(error){errors.push(error);}
    this.state = 'stopped';
    if(errors.length)throw new AggregateError(errors,'Task Relay stopped with a transport or dispatch failure');
  }
}

export function mountTaskRelay(app: Express, relay: TaskRelayGateway, store: JobStore|TaskRelayGatewayPort, authenticate: RequestHandler, principal: (req: Request) => Principal) {
  const port='security'in store?sqliteTaskRelayGatewayPort(store):store;
  const reject = (res: import('express').Response, error: unknown) => {
    if (error instanceof SecurityError) res.status(error.reason === 'AUTHORITY_UNAVAILABLE' ? 503 : 403).json({ error: error.reason });
    else if (error instanceof RelayError) res.status(error.status).json({ error: 'relay_binding_rejected' });
    else res.status(400).json({ error: 'invalid_relay_binding' });
  };
  app.get('/.well-known/eigos-task-relay', (_req, res) => { try { res.json(relay.metadata()); } catch (error) { reject(res, error); } });
  app.get('/.well-known/eigos-relay-jwks.json', (_req, res) => {
    if (!relay.enrollment) { res.sendStatus(404); return; }
    res.json(relay.enrollment.jwks());
  });
  app.post('/relay/enrollment', authenticate, async (req, res) => {
    try {
      const proof = z.string().min(1).max(4096).parse(req.headers.dpop);
      res.json(await relay.enroll(principal(req), req.headers.authorization!.slice('Bearer '.length), req.body, proof));
    } catch (error) { reject(res, error); }
  });
  app.post('/relay/enroll-primary', authenticate, async (req, res) => {
    try {
      const { renewRequestId } = z.strictObject({ renewRequestId: z.uuid().optional() }).parse(req.body);
      res.json(await relay.enrollPrimary(principal(req), req.headers.authorization!.slice('Bearer '.length), renewRequestId));
    } catch (error) { reject(res, error); }
  });
  app.post('/relay/bind', authenticate, async (req, res) => {
    try {
      const token = req.headers.authorization!.slice('Bearer '.length), proof = z.string().min(1).max(4096).parse(req.headers.dpop);
      res.json(await relay.bind(principal(req), token, req.body, proof));
    } catch (error) { reject(res, error); }
  });
  app.post('/relay/revoke', authenticate, async (req, res) => {
    try {
      const { agentId } = z.strictObject({ agentId: agentIdSchema }).parse(req.body);
      await port.revoke(principal(req),agentId);
      res.json({ revoked: true });
    } catch (error) { reject(res, error); }
  });
  app.post('/relay/source-reads/:id/authorize', async (req, res) => {
    try {
      const id = z.uuid().parse(req.params.id), proof = z.string().min(1).max(4096).parse(req.headers.dpop);
      z.strictObject({}).parse(req.body);
      const peer = await port.reads.peer(id), url = port.gatewayOrigin + `/relay/source-reads/${id}/authorize`;
      const checked = await verifyProof(proof, id, 'POST', url, peer, port.now());
      const request = await port.reads.authorizeProof(id,peer,checked);
      res.json({ authorized: true, authorityId: request.authorityId, callId: id, requestDigest: digest(request), expiresAt: request.expiresAt });
    } catch (error) { reject(res, error); }
  });
}
