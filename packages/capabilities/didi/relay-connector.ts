import { setTimeout as delay } from 'node:timers/promises';
import type { JobStore } from '../../core/store.js';
import { digest } from '../../core/delegation.js';
import { sourceReadContextSchema } from '../../agent-transport/service-contracts.js';
import type { DidiBinding, DidiTool } from './contracts.js';
import { DidiReadError, type DidiCallContext, type DidiConnector, type DidiReadResult } from './connector.js';

/** The Worker retains decisions/authority; the enrolled source node owns provider credentials. */
export class DidiRelayConnector implements DidiConnector {
  readonly evidenceKind = 'live_readonly' as const;
  readonly transportDigest: string;
  constructor(private store: JobStore, private peerId: string, private binding: DidiBinding) {
    if (!store.authority || !store.security.enabled || binding.environment !== 'production') throw new Error('Relay DiDi reads require the primary Foundation authority');
    this.transportDigest = digest({ protocol: 'eigos.source-read/1', authorityId: store.authority.id, gatewayOrigin: store.authority.canonicalOrigin, peerId });
  }
  async invoke(context: DidiCallContext, tool: DidiTool, input: Record<string, unknown>, signal: AbortSignal, beforeCall?: () => void | Promise<void>): Promise<DidiReadResult> {
    signal.throwIfAborted(); await beforeCall?.();
    const request = this.store.security.relayReads.create(this.peerId, {
      authorityId: this.store.authority!.id, gatewayOrigin: this.store.authority!.canonicalOrigin,
      source: { bindingId: this.binding.bindingId, keySha256: this.binding.keySha256, environment: 'production' },
      context: sourceReadContextSchema.parse(context), tool, input,
    });
    try {
      while (!signal.aborted && Date.now() < request.expiresAt) {
        // Account admission and the immutable component scope remain current
        // while waiting, as do the task/source/Pipeline fences in ready().
        await beforeCall?.();
        if(!this.store.security.relayReads.ready(request.callId)){
          await delay(100,undefined,{signal});continue;
        }
        const response = this.store.security.relayReads.result(request.callId);
        if (response?.error) throw new DidiReadError(response.error);
        if (response?.result) { signal.throwIfAborted(); await beforeCall?.(); return response.result; }
        await delay(100, undefined, { signal });
      }
      throw new DidiReadError(signal.aborted ? 'ABORTED' : 'READ_OUTCOME_UNKNOWN');
    } finally { this.store.security.relayReads.revoke(request.callId); }
  }
}
