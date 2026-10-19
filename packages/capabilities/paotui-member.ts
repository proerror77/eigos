import type { AdapterContext, Delivery, ExecutionAdapter, Preparation } from '../core/catalog.js';
import type { JobStore } from '../core/store.js';
import { MemberSourceVault, SourceAuthorizationRequired, type SourceGrant } from '../core/member-source.js';
import { digest } from '../core/delegation.js';
import { DomainError, ReplanRequired } from '../core/domain.js';
import type { ExecutionPlan } from '../ontology/execution.js';
import { OntologyMcpPaotuiReader } from './paotui-mcp.js';
import { PaotuiReadAdapter, PAOTUI_READ_BINDINGS } from './paotui-read.js';
import { PaotuiRequestAdapter, DELIVERY_REQUEST_BINDING } from './paotui-request.js';

type PrivateData = { sourceGrant: SourceGrant; [key: string]: unknown };
/** Shared capability metadata, but a fresh owner-bound reader for every preparation/dispatch. */
export class MemberPaotuiAdapter implements ExecutionAdapter {
  readonly id: string;
  constructor(private kind: 'quote' | 'addresses', private vault: MemberSourceVault, private store: JobStore, private directory: string, private executeReads: boolean, private auditPath?: string) {
    this.id = kind === 'quote' ? DELIVERY_REQUEST_BINDING.adapterId : PAOTUI_READ_BINDINGS[2]!.adapterId;
  }
  permitted(owner: string) {
    try { const p = JSON.parse(owner); return Array.isArray(p) && p.length === 3 && typeof p[0] === 'string' && new URL(p[0]).protocol === 'https:'; } catch { return false; }
  }
  sourceAuthorization(owner: string) { const s = this.vault.status(owner); return { provider: s.provider, state: s.state, nextAction: s.nextAction }; }
  private bound(owner: string, grant: SourceGrant): ExecutionAdapter {
    if (!this.permitted(owner) || owner !== grant.owner) throw new DomainError('FORBIDDEN', 'Source owner mismatch');
    this.vault.assert(grant);
    const reader = new OntologyMcpPaotuiReader(this.directory, this.auditPath, { memberSource: { vault: this.vault, grant }, databasePath: this.store.databasePath, execute: this.executeReads });
    const access = { permitted: (candidate: string) => { if (candidate !== owner) return false; this.vault.assert(grant); return true; } };
    return this.kind === 'quote' ? new PaotuiRequestAdapter(reader, this.store, digest(grant), access) : new PaotuiReadAdapter(2, reader, access);
  }
  async prepare(ctx: AdapterContext, input: unknown, signal: AbortSignal): Promise<Preparation> {
    const grant = this.vault.grant(ctx.owner), adapter = this.bound(ctx.owner, grant);
    if (this.kind === 'quote') {
      const previous = this.store.preparationContext<{ digest: string }>(ctx.owner, ctx.request.id, 'member-source-selection');
      if (previous && previous.digest !== digest(grant) && input && typeof input === 'object') input = { ...input, sender: null, recipient: null };
      this.store.savePreparationContext(ctx.owner, ctx.request.id, 'member-source-selection', { digest: digest(grant) });
    }
    let prepared: Preparation;
    try { prepared = await adapter.prepare(ctx, input, signal); this.vault.assert(grant); }
    catch (error) { if (error instanceof ReplanRequired) throw new SourceAuthorizationRequired(); throw error; }
    return prepared.kind === 'ready' ? { ...prepared, privateData: { ...(prepared.privateData as Record<string, unknown>), sourceGrant: grant } satisfies PrivateData } : prepared;
  }
  execute(ctx: AdapterContext, plan: ExecutionPlan, data: unknown, signal: AbortSignal): Promise<Delivery> {
    const { sourceGrant, ...payload } = data as PrivateData; return this.bound(ctx.owner, sourceGrant).execute(ctx, plan, payload, signal);
  }
  verify(ctx: AdapterContext, plan: ExecutionPlan, data: unknown, delivery: Delivery) {
    const { sourceGrant, ...payload } = data as PrivateData; return this.bound(ctx.owner, sourceGrant).verify(ctx, plan, payload, delivery);
  }
}
