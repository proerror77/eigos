import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { agentIdSchema } from '../relay/contracts.js';
import { didiToolInputs } from '../capabilities/didi/contracts.js';
import { sourceReadRequestSchema, sourceReadResponseSchema, SOURCE_RELAY_PROTOCOL, type SourceReadRequest, type SourceReadResponse } from '../agent-transport/service-contracts.js';
import { accessContextSchema } from './contracts.js';
import { authorizationScope, withAuthorization } from './context.js';
import { SecurityError, type SecurityStore } from './store.js';
import type { ActionIntent, ExecutionAttempt } from '../ontology/actions.js';
import type { AgentActionPlan } from '../ontology/agent-actions.js';

type Row = Record<string, unknown>;
/** Durable transport work, stored with the task authority. It creates no new business grant. */
export class RelayReadAuthority {
  private pipelineGuard?: (owner: string, request: SourceReadRequest, plan: AgentActionPlan, intent: ActionIntent) => void;
  constructor(private db: DatabaseSync, private security: SecurityStore, readOnly: boolean) {
    if (!readOnly) db.exec(`CREATE TABLE IF NOT EXISTS security_relay_reads (
      id TEXT PRIMARY KEY, retry_key TEXT NOT NULL UNIQUE, peer_id TEXT NOT NULL, actor TEXT NOT NULL,
      policy_revision INTEGER NOT NULL, request TEXT NOT NULL, state TEXT NOT NULL,
      connection_id TEXT, result TEXT, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS security_relay_reads_pending ON security_relay_reads(state,expires_at);`);
  }
  setPipelineGuard(guard: NonNullable<RelayReadAuthority['pipelineGuard']>) {
    if (this.pipelineGuard) throw new Error('The source Pipeline guard is already bound');
    this.pipelineGuard = guard;
  }
  private row(id: string): Row {
    return this.db.prepare('SELECT * FROM security_relay_reads WHERE id=?').get(z.uuid().parse(id)) ?? (() => { throw new SecurityError('AUTHORIZATION_REQUIRED'); })();
  }
  private assert(row: Row): SourceReadRequest {
    if (Number(row.expires_at) <= this.security.now() || row.state === 'revoked') throw new SecurityError('ACCESS_REVOKED');
    const actor = accessContextSchema.parse(JSON.parse(String(row.actor))), request = sourceReadRequestSchema.parse(JSON.parse(String(row.request)));
    if (actor.actorKind !== 'worker' || actor.taskId !== request.context.requestId || actor.requestRevision !== request.context.requestRevision) throw new SecurityError('AUTHORIZATION_REQUIRED');
    const scope = this.security.scope(actor, actor.taskId, 'task.process');
    if (scope.policyRevision !== row.policy_revision) throw new SecurityError('POLICY_CHANGED');
    withAuthorization(scope, () => scope.policies.readSnapshot(() => {
      scope.policies.requireSource(scope, request.context.programId, request.context.programDigest, request.context.action);
      scope.policies.requireResource(scope, 'actionType', request.context.action, 'action.execute');
      const intentRow = this.db.prepare("SELECT body FROM action_intents WHERE owner=? AND job_id=? AND id=? AND state='dispatching'")
        .get(actor.ownerKey, actor.taskId, request.context.intentId);
      const attemptRow = this.db.prepare('SELECT body FROM action_attempts WHERE owner=? AND intent_id=? AND id=?')
        .get(actor.ownerKey, request.context.intentId, request.context.attemptId);
      if (!intentRow || !attemptRow) throw new SecurityError('ACCESS_REVOKED');
      const intent = JSON.parse(String(intentRow.body)) as ActionIntent, attempt = JSON.parse(String(attemptRow.body)) as ExecutionAttempt;
      const { plan, step } = scope.policies.requireDispatch(actor.ownerKey, intent, 'dispatch');
      if (intent.effect !== 'read' || step.effect !== 'read' || plan.id !== request.context.planId || step.action !== request.context.action
        || plan.modelRunId !== request.context.modelRunId || attempt.inputDigest !== request.context.actionInputDigest
        || digest(attempt.claimToken) !== actor.claimRef || attempt.planDigest !== plan.digest
        || !intent.dispatchInput || digest(intent.dispatchInput) !== request.context.actionInputDigest) throw new SecurityError('AUTHORIZATION_REQUIRED');
      if (!this.pipelineGuard) throw new SecurityError('AUTHORITY_UNAVAILABLE');
      try { this.pipelineGuard(actor.ownerKey, request, plan, intent); }
      catch (error) { if (error instanceof DomainError) throw new SecurityError('SOURCE_NOT_AUTHORIZED'); throw error; }
    }));
    return request;
  }
  create(peerId: string, input: Omit<SourceReadRequest, 'protocol' | 'kind' | 'callId' | 'expiresAt'>): SourceReadRequest {
    agentIdSchema.parse(peerId);
    const scope = authorizationScope();
    if (!this.security.enabled || scope?.actor.actorKind !== 'worker' || scope.policies.security !== this.security || !scope.grant) throw new SecurityError('AUTHORIZATION_REQUIRED');
    scope.assertCurrent();
    const request = sourceReadRequestSchema.parse({ ...input, protocol: SOURCE_RELAY_PROTOCOL, kind: 'source.read', callId: randomUUID(),
      expiresAt: Math.min(this.security.now() + 120000, Date.parse(scope.grant.expiresAt)) });
    const parsedInput = didiToolInputs[request.tool].parse(request.input);
    if (digest(parsedInput) !== digest(request.input)) throw new SecurityError('AUTHORIZATION_REQUIRED');
    const retryKey = digest([peerId, input]);
    return this.security.atomic(() => {
      const existing = this.db.prepare('SELECT * FROM security_relay_reads WHERE retry_key=?').get(retryKey);
      if (existing) {
        if (digest(JSON.parse(String(existing.actor))) !== digest(scope.actor)) throw new SecurityError('ACCESS_REVOKED');
        return this.assert(existing);
      }
      const row = { id: request.callId, peer_id: peerId, actor: JSON.stringify(scope.actor), policy_revision: scope.policyRevision,
        request: JSON.stringify(request), state: 'queued', expires_at: request.expiresAt };
      this.assert(row);
      this.db.prepare("INSERT INTO security_relay_reads VALUES(?,?,?,?,?,?,'queued',NULL,NULL,?)")
        .run(request.callId, retryKey, peerId, row.actor, scope.policyRevision, row.request, request.expiresAt);
      return request;
    });
  }
  pending(): { peerId: string; request: SourceReadRequest }[] {
    const results: { peerId: string; request: SourceReadRequest }[] = [];
    for (const row of this.db.prepare("SELECT * FROM security_relay_reads WHERE state='queued' ORDER BY rowid LIMIT 20").all()) {
      try { results.push({ peerId: String(row.peer_id), request: this.assert(row) }); }
      catch (error) {
        if (!(error instanceof SecurityError)) throw error;
        this.db.prepare("UPDATE security_relay_reads SET state='revoked' WHERE id=?").run(String(row.id));
      }
    }
    return results;
  }
  authorize(id: string, peerId?: string): SourceReadRequest {
    const row = this.row(id);
    if (peerId !== undefined && row.peer_id !== peerId) throw new SecurityError('AUTHORIZATION_REQUIRED');
    return this.assert(row);
  }
  peer(id: string): string { return String(this.row(id).peer_id); }
  route(id: string, connectionId: string) {
    const row = this.row(id); this.assert(row);
    if (row.connection_id && row.connection_id !== connectionId) throw new SecurityError('ACCESS_REVOKED');
    this.db.prepare('UPDATE security_relay_reads SET connection_id=? WHERE id=?').run(z.uuid().parse(connectionId), id);
  }
  dispatched(id: string, connectionId: string) {
    const row = this.row(id); this.assert(row);
    if (row.connection_id && row.connection_id !== connectionId) throw new SecurityError('ACCESS_REVOKED');
    this.db.prepare("UPDATE security_relay_reads SET state=CASE WHEN state='queued' THEN 'dispatched' ELSE state END,connection_id=? WHERE id=?")
      .run(z.uuid().parse(connectionId), id);
  }
  accept(peerId: string, connectionId: string, input: unknown) {
    const result = sourceReadResponseSchema.parse(input);
    this.security.atomic(() => {
      const row = this.row(result.callId), request = this.assert(row);
      if (row.peer_id !== peerId || row.connection_id !== connectionId || result.requestDigest !== digest(request) || result.authorityId !== request.authorityId) throw new SecurityError('AUTHORIZATION_REQUIRED');
      if (row.result && digest(JSON.parse(String(row.result))) !== digest(result)) throw new SecurityError('POLICY_CHANGED');
      this.db.prepare("UPDATE security_relay_reads SET state='completed',result=? WHERE id=?").run(JSON.stringify(result), result.callId);
    });
  }
  result(id: string): SourceReadResponse | undefined {
    const row = this.row(id); this.assert(row);
    return row.result ? sourceReadResponseSchema.parse(JSON.parse(String(row.result))) : undefined;
  }
  revoke(id: string) { this.db.prepare("UPDATE security_relay_reads SET state='revoked' WHERE id=? AND state<>'completed'").run(z.uuid().parse(id)); }
}
