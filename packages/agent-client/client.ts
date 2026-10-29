import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, statSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { decodeJwt } from 'jose';
import * as oidc from 'openid-client';
import { z } from 'zod';
import type { Profile } from '../members/store.js';
import type { RelayClient } from '../agent-transport/client.js';
import { taskRelayMetadataSchema } from '../agent-transport/task-contracts.js';
import { ClientFactory, JsonRpcTransportFactory, type Client } from '@a2a-js/sdk/client';
import { discoverA2A } from './a2a.js';

const metadataSchema = z.object({ version: z.literal(1), registration_endpoint: z.url(), issuer: z.url(), client_id: z.string().min(1), audience: z.url(), scopes: z.array(z.string()) });
const admissionSchema = z.object({ registrationId: z.uuid(), status: z.string(), nextAction: z.string(), pollAfterSeconds: z.number(), links: z.record(z.string(), z.url()) });
export type AgentAdmission = z.infer<typeof admissionSchema>;
type Metadata = z.infer<typeof metadataSchema>;
type Device = Awaited<ReturnType<typeof oidc.initiateDeviceAuthorization>>;
type Tokens = Awaited<ReturnType<typeof oidc.refreshTokenGrant>>;
type State = { version: 1; baseUrl: string; issuer: string; clientId: string; registrationId: string; credential: string; displayName: string;
  accessToken?: string; refreshToken?: string; expiresAt?: number; bound?: boolean; refreshPending?: boolean; refreshCount?: number;
  device?: Device; deviceExpiresAt?: number };
const stateSchema = z.object({ version: z.literal(1), baseUrl: z.url(), issuer: z.url(), clientId: z.string(), registrationId: z.uuid(), credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/), displayName: z.string() });

export class AgentConnectorError extends Error {
  constructor(readonly code: string, readonly admission?: AgentAdmission) { super(code); }
}

/** Node Agent adapter. One private credential file per installation, no server-side refresh-token custody. */
export class AgentConnector {
  private state!: State;
  private inflight?: Promise<string>;
  private config?: Promise<oidc.Configuration>;
  private constructor(readonly baseUrl: string, private path: string, private metadata: Metadata, private fetcher: typeof fetch) {}
  static async open(options: { baseUrl: string; credentialPath: string; displayName: string; fetch?: typeof fetch }): Promise<AgentConnector> {
    const origin = new URL(options.baseUrl);
    if (origin.protocol !== 'https:' || origin.origin !== options.baseUrl) throw new AgentConnectorError('https_origin_required');
    const fetcher = options.fetch ?? fetch;
    const response = await fetcher(options.baseUrl + '/.well-known/eigos-agent-registration', { redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new AgentConnectorError('agent_onboarding_unavailable');
    const metadata = metadataSchema.parse(await response.json());
    if (metadata.registration_endpoint !== options.baseUrl + '/agents/registrations' || new URL(metadata.issuer).protocol !== 'https:') throw new AgentConnectorError('invalid_onboarding_metadata');
    const client = new AgentConnector(options.baseUrl, resolve(options.credentialPath), metadata, fetcher);
    await client.lock(async () => {
      if (existsSync(client.path)) client.reload();
      else {
        client.state = { version: 1, baseUrl: options.baseUrl, issuer: metadata.issuer, clientId: metadata.client_id,
          registrationId: randomUUID(), credential: randomBytes(32).toString('base64url'), displayName: z.string().trim().min(1).max(80).parse(options.displayName) };
        // Persist the idempotency identity BEFORE the registration request.
        client.save();
      }
      const admission = await client.registrationRequest('', undefined, { registrationId: client.state.registrationId, displayName: client.state.displayName }, true);
      // A successful provider response is saved before binding. If the binding
      // acknowledgement was lost, resume that idempotent operation, not a new grant.
      if (client.state.accessToken && !client.state.bound && (client.state.expiresAt ?? 0) > Date.now() && !['agent_registration_revoked', 'registration_expired'].includes(admission.status)) {
        await client.bind(); client.state.bound = true; client.save();
      }
    });
    return client;
  }
  get registrationId(): string { return this.state.registrationId; }
  get refreshCount(): number { return this.state.refreshCount ?? 0; }
  private reload(): void {
    const stat = statSync(this.path);
    if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new AgentConnectorError('private_credential_file_required');
    const state = JSON.parse(readFileSync(this.path, 'utf8')) as State; stateSchema.parse(state);
    if (state.baseUrl !== this.baseUrl || state.issuer !== this.metadata.issuer || state.clientId !== this.metadata.client_id) throw new AgentConnectorError('credential_destination_mismatch');
    this.state = state;
  }
  private save(): void {
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    writeFileSync(temporary, JSON.stringify(this.state) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, this.path);
  }
  private async lock<T>(fn: () => Promise<T>): Promise<T> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const path = this.path + '.lock'; let handle: number;
    try { handle = openSync(path, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A crashed owner can be recovered; a live owner is never displaced by a timer.
      const pid = Number(readFileSync(path, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new AgentConnectorError('credentials_in_use');
      try { process.kill(pid, 0); throw new AgentConnectorError('credentials_in_use'); }
      catch (check) { if ((check as NodeJS.ErrnoException).code !== 'ESRCH') throw check; }
      unlinkSync(path); handle = openSync(path, 'wx', 0o600);
    }
    writeFileSync(handle, String(process.pid));
    try { if (existsSync(this.path)) this.reload(); return await fn(); }
    finally { closeSync(handle); unlinkSync(path); }
  }
  private discover(): Promise<oidc.Configuration> {
    return this.config ??= oidc.discovery(new URL(this.metadata.issuer), this.metadata.client_id, undefined, oidc.None(), {
      timeout: 10, [oidc.customFetch]: (url, options) => this.fetcher(url, { ...options, body: options.body instanceof Uint8Array ? new Uint8Array(options.body) : options.body }),
    }).then(config => {
      const m = config.serverMetadata();
      for (const url of [m.token_endpoint, m.device_authorization_endpoint, m.jwks_uri]) if (!url || new URL(url).protocol !== 'https:') throw new AgentConnectorError('https_provider_endpoints_required');
      oidc.enableNonRepudiationChecks(config); return config;
    });
  }
  private async registrationRequest(action: string, accessToken?: string, body?: unknown, create = false): Promise<AgentAdmission> {
    const url = create ? this.metadata.registration_endpoint : `${this.metadata.registration_endpoint}/${this.state.registrationId}${action ? '/' + action : ''}`;
    const response = await this.fetcher(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'X-EIGOS-Registration-Token': this.state.credential, ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) throw new AgentConnectorError(typeof value.error === 'string' ? value.error : 'registration_request_failed');
    const admission = admissionSchema.parse(value);
    if (admission.registrationId !== this.state.registrationId) throw new AgentConnectorError('registration_response_mismatch');
    return admission;
  }
  async status(): Promise<AgentAdmission> { return this.registrationRequest(''); }
  async beginAuthorization(): Promise<{ verificationUri: string; userCode: string; expiresAt: number }> {
    return this.lock(async () => {
      const status = await this.status();
      if (['agent_registration_revoked', 'registration_expired'].includes(status.status)) throw new AgentConnectorError(status.status, status);
      if (!this.state.device || (this.state.deviceExpiresAt ?? 0) <= Date.now()) {
        this.state.device = await oidc.initiateDeviceAuthorization(await this.discover(), { scope: this.metadata.scopes.join(' '), audience: this.metadata.audience });
        this.state.deviceExpiresAt = Date.now() + this.state.device.expires_in * 1000; this.save();
      }
      return { verificationUri: this.state.device.verification_uri_complete ?? this.state.device.verification_uri, userCode: this.state.device.user_code, expiresAt: this.state.deviceExpiresAt! };
    });
  }
  async finishAuthorization(): Promise<AgentAdmission> {
    return this.lock(async () => {
      if (!this.state.device || (this.state.deviceExpiresAt ?? 0) <= Date.now()) throw new AgentConnectorError('authorization_required');
      const tokens = await oidc.pollDeviceAuthorizationGrant(await this.discover(), this.state.device);
      this.install(tokens); delete this.state.device; delete this.state.deviceExpiresAt; this.save();
      const status = await this.bind(); this.state.bound = true; this.save(); return status;
    });
  }
  private install(tokens: Tokens, rotating = false): void {
    if (tokens.token_type.toLowerCase() !== 'bearer' || !tokens.refresh_token || (rotating && tokens.refresh_token === this.state.refreshToken)) throw new AgentConnectorError('rotating_refresh_token_required');
    const exp = z.number().parse(decodeJwt(tokens.access_token).exp);
    this.state.accessToken = tokens.access_token; this.state.refreshToken = tokens.refresh_token;
    this.state.expiresAt = exp * 1000; this.state.bound = false; this.state.refreshPending = false;
    if (rotating) this.state.refreshCount = (this.state.refreshCount ?? 0) + 1;
  }
  private bind(): Promise<AgentAdmission> { return this.registrationRequest('token', this.state.accessToken, {}); }
  private rawToken(forceRefresh = false): Promise<string> {
    if (this.inflight) return this.inflight;
    this.inflight = this.lock(async () => {
      if (this.state.refreshPending) throw new AgentConnectorError('reauthorization_required_after_uncertain_refresh');
      if (forceRefresh || !this.state.accessToken || (this.state.expiresAt ?? 0) <= Date.now() + 10000) {
        if (!this.state.refreshToken) throw new AgentConnectorError('authorization_required');
        this.state.refreshPending = true; this.save();
        // Never retry an uncertain rotating grant with the old refresh token.
        const tokens = await oidc.refreshTokenGrant(await this.discover(), this.state.refreshToken);
        this.install(tokens, true); this.save();
      }
      if (!this.state.bound) { await this.bind(); this.state.bound = true; this.save(); }
      return this.state.accessToken!;
    }).finally(() => { this.inflight = undefined; });
    return this.inflight;
  }
  async accessToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
    const admission = await this.status();
    if (!['active','foundation_ready'].includes(admission.status)) throw new AgentConnectorError(admission.status, admission);
    return this.rawToken(options.forceRefresh);
  }
  async registerMembership(profile: Profile, consent: true): Promise<AgentAdmission> {
    return this.registrationRequest('application', await this.rawToken(), { ...profile, consent });
  }
  async redeemInvitation(invitationToken: string): Promise<AgentAdmission> {
    return this.registrationRequest('invitation', await this.rawToken(), { invitationToken });
  }
  async revoke(): Promise<AgentAdmission> { return this.registrationRequest('revoke', await this.rawToken(), {}); }
  /** Call from PA host code, outside model/tool arguments. The credential is never persisted in connector state. */
  async connectSource(options: { requestId: string; expectedRevision: number; loadCredential: () => Promise<{ token: string; expiresAt: string }> }): Promise<unknown> {
    try {
      const args = z.object({ requestId: z.uuid(), expectedRevision: z.number().int().nonnegative() }).parse(options);
      const begin = await this.fetch('/sources/meituan-paotui/begin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
      if (!begin.ok) throw new AgentConnectorError('source_connection_begin_rejected');
      const ticket = z.object({ requestId: z.uuid(), uploadPath: z.literal('/sources/meituan-paotui/credential'), completed: z.boolean().optional(), status: z.record(z.string(), z.unknown()).optional() }).parse(await begin.json());
      if (ticket.requestId !== args.requestId) throw new AgentConnectorError('source_connection_request_mismatch');
      if (ticket.completed) { if (!ticket.status) throw new AgentConnectorError('source_connection_response_invalid'); return ticket.status; }
      const credential = await options.loadCredential();
      const upload = await this.fetch(ticket.uploadPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: args.requestId, token: credential.token, expiresAt: credential.expiresAt }) });
      if (!upload.ok) throw new AgentConnectorError('source_connection_upload_rejected');
      return await upload.json();
    } catch (error) {
      // Host callbacks and fetch errors may contain secret material. Preserve only our fixed codes.
      if (error instanceof AgentConnectorError && ['source_connection_begin_rejected', 'source_connection_request_mismatch', 'source_connection_upload_rejected', 'source_connection_response_invalid'].includes(error.code)) throw error;
      throw new AgentConnectorError('source_connection_failed');
    }
  }
  async fetch(path: string | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl) throw new AgentConnectorError('credential_destination_mismatch');
    const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${await this.accessToken()}`);
    // No automatic replay of task-creating POSTs after errors or token races.
    return this.fetcher(url, { ...init, headers, redirect: 'error' });
  }
  /** Official A2A SDK, using the same installed identity and rotating OAuth
   * credentials as MCP. Discovery is public; task POSTs are never replayed. */
  async a2a(): Promise<Client> {
    const card = await discoverA2A(this.baseUrl, this.fetcher);
    const scheme = card.securitySchemes.eigos?.scheme;
    const issuerMetadata = this.metadata.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration';
    if (scheme?.$case !== 'openIdConnectSecurityScheme' || scheme.value.openIdConnectUrl !== issuerMetadata) {
      throw new AgentConnectorError('a2a_identity_provider_mismatch');
    }
    return new ClientFactory({
      clientConfig: { polling: true },
      transports: [new JsonRpcTransportFactory({ fetchImpl: (input, init) => this.fetch(
        input instanceof Request ? input.url : input.toString(),
        { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) },
      ) })],
    }).createFromAgentCard(card);
  }
  private async json(path:string,body?:unknown) {
    const response=await this.fetch(path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new AgentConnectorError(response.status===403?'task_permission_required':`gateway_http_${response.status}`);
    return response.json();
  }
  async authorizationContext() {
    const value=z.object({stage:z.enum(['S4','S5']),installationId:z.uuid(),actorKind:z.literal('agent'),grant:z.object({id:z.uuid(),revision:z.number().int().positive()}),authEpoch:z.number().int().positive()}).parse(await this.json('/security/context',{}));
    if(value.installationId!==this.registrationId)throw new AgentConnectorError('installation_context_mismatch');return value;
  }
  /** Uses the existing OAuth installation to bind a transport key; refresh credentials stay here. */
  async bindTaskRelay(relay: RelayClient, expected?: { authorityId: string; gatewayAgentId: string }) {
    const context = await this.authorizationContext();
    const metadata = taskRelayMetadataSchema.parse(await this.json('/.well-known/eigos-task-relay'));
    if (metadata.gatewayOrigin !== this.baseUrl || metadata.relayUrl !== relay.baseUrl) throw new AgentConnectorError('relay_destination_mismatch');
    if (expected && (metadata.authorityId !== expected.authorityId || metadata.gatewayAgentId !== expected.gatewayAgentId)) throw new AgentConnectorError('relay_authority_mismatch');
    const token = await this.accessToken(), proof = await relay.taskBindingProof(token, this.baseUrl);
    const response = await this.fetcher(this.baseUrl + metadata.bindingPath, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, DPoP: proof, 'Content-Type': 'application/json' }, body: JSON.stringify({ signedCard: relay.identity.signedCard }) });
    if (!response.ok) throw new AgentConnectorError('relay_binding_rejected');
    const value = taskRelayMetadataSchema.extend({ agentId: z.string(), installationId: z.uuid(), expiresAt: z.number().int(), connectionId: z.uuid() }).parse(await response.json());
    if (value.agentId !== relay.agentId || value.installationId !== context.installationId || value.authorityId !== metadata.authorityId
      || value.gatewayAgentId !== metadata.gatewayAgentId || value.gatewayOrigin !== metadata.gatewayOrigin || value.relayUrl !== metadata.relayUrl) throw new AgentConnectorError('relay_binding_mismatch');
    const contact = (await relay.contacts()).find(c => c.id === value.connectionId);
    if (!contact || ![contact.requester, contact.recipient].includes(metadata.gatewayAgentId)) throw new AgentConnectorError('relay_contact_mismatch');
    if (contact.state === 'pending' && contact.recipient === relay.agentId) await relay.respondContact(contact.id, 'accept');
    else if (contact.state !== 'accepted') throw new AgentConnectorError('relay_contact_not_accepted');
    return value;
  }
  async enrollTaskRelay(relay: RelayClient, options: { renew?: boolean; requestId?: string } = {}) {
    if (options.renew && !z.uuid().safeParse(options.requestId).success) throw new AgentConnectorError('relay_renewal_request_id_required');
    const metadata = taskRelayMetadataSchema.parse(await this.json('/.well-known/eigos-task-relay'));
    if (metadata.gatewayOrigin !== this.baseUrl || metadata.relayUrl !== relay.baseUrl || !metadata.enrollmentPath) throw new AgentConnectorError('relay_enrollment_unavailable');
    const token = await this.accessToken(), proof = await relay.enrollmentProof(token, this.baseUrl);
    const response = await this.fetcher(this.baseUrl + metadata.enrollmentPath, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, DPoP: proof, 'Content-Type': 'application/json' }, body: JSON.stringify({ signedCard: relay.identity.signedCard }) });
    if (!response.ok) throw new AgentConnectorError('relay_enrollment_rejected');
    const assertion = z.strictObject({ accessToken: z.string().max(8192), expiresAt: z.number().int(), agentId: z.string() }).parse(await response.json());
    if (assertion.agentId !== relay.agentId || assertion.expiresAt <= Date.now()) throw new AgentConnectorError('relay_enrollment_mismatch');
    return options.renew ? relay.renew(assertion.accessToken, options.requestId) : relay.register(assertion.accessToken);
  }
  /** Explicit v2 calls have no owner-wide fallback after a denial or old server. */
  async queryOntology(taskId:string,query:unknown,expectedRequestRevision?:number) {
    return this.json('/ontology/query',{version:2,taskId:z.uuid().parse(taskId),...(expectedRequestRevision===undefined?{}:{expectedRequestRevision:z.number().int().positive().parse(expectedRequestRevision)}),query});
  }
  async evaluateOntology(taskId:string,call:unknown,expectedRequestRevision?:number) {
    return this.json('/ontology/evaluate',{version:2,taskId:z.uuid().parse(taskId),...(expectedRequestRevision===undefined?{}:{expectedRequestRevision:z.number().int().positive().parse(expectedRequestRevision)}),call});
  }
  async checkAccess(input:{taskId:string;operation:string;[key:string]:unknown}) {return this.json('/ontology/check-access',input);}
}
