import { z } from 'zod';
import type { AdapterContext, DiscoverySource, ExecutionAdapter, Preparation } from '../core/catalog.js';
import { sameRef } from '../core/catalog.js';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { ExecutionPlan } from '../ontology/execution.js';
import type { DiscoveryCoverage } from '../ontology/supply.js';
import type { PaotuiReader } from './paotui-contracts.js';
import { ontologyReceiptSchema } from './paotui-mcp-server.js';
import { PAOTUI_READ_BINDINGS, PAOTUI_READ_CAPABILITIES, paotuiReadDefinitions } from './paotui-ontology.js';
import { PaotuiReadAdapter } from './paotui-read.js';
import { paotuiPublicPlaceSchema } from './paotui-public-locations.js';

const capability = PAOTUI_READ_CAPABILITIES[0]!;
const binding = PAOTUI_READ_BINDINGS[0]!;
const inputSchema = paotuiReadDefinitions[0].schema;
const querySchema = inputSchema.extend({ action: z.literal('search_address') }).strict();
export type PublicGeoQuery = z.infer<typeof inputSchema>;
const resultSchema = z.object({
  source: z.literal('meituan'), readOnly: z.literal(true), places: z.array(paotuiPublicPlaceSchema).max(100),
  ontologyReceipt: ontologyReceiptSchema,
}).strict();

// An explicitly permitted public query yields one search-service candidate.
// A POI is not a merchant capability, stock observation, quote or fulfillment proof.
export class PaotuiGeoDiscoverySource implements DiscoverySource {
  readonly id = 'meituan:public-geo-discovery';
  readonly channelId = 'meituan';
  readonly realSupply = false;
  readonly adapterId = binding.adapterId;
  readonly capabilityRefs = [capability.ref];
  readonly configurationDigest: string;
  readonly adapter: ExecutionAdapter;
  private readonly allowedQueries: Set<string>;

  constructor(reader: PaotuiReader, readerConfigurationDigest: string, allowedQueries: readonly PublicGeoQuery[] = []) {
    const queries = z.array(inputSchema).max(16).parse(allowedQueries);
    this.allowedQueries = new Set(queries.map(query => digest(query)));
    this.configurationDigest = digest({ readerConfigurationDigest, publicQueries: [...this.allowedQueries].sort(), sourceVersion: '2' });
    const protectedReader: PaotuiReader = { query: async (value, signal) => {
      const query = querySchema.parse(value);
      const { action: _action, ...input } = query;
      this.allowedInput(input);
      signal.throwIfAborted();
      // Never forward the request goal, messages, address book, or personal context.
      const result = await reader.query(query, signal);
      signal.throwIfAborted();
      return this.checkedResult(result, input);
    } };
    const implementation = new PaotuiReadAdapter(0, protectedReader);
    this.adapter = {
      id: this.adapterId, permitted: owner => this.permitted(owner),
      prepare: async (ctx, input, signal) => {
        this.requireOwner(ctx.owner);
        return implementation.prepare(ctx, this.allowedInput(input), signal);
      },
      execute: async (ctx, plan, data, signal) => {
        this.checkedPreparation(ctx, plan, data);
        signal.throwIfAborted();
        return implementation.execute(ctx, plan, data, signal);
      },
      verify: (ctx, plan, data, delivery) => {
        try {
          const prepared = this.checkedPreparation(ctx, plan, data);
          const actual = this.checkedResult(delivery.artifact.data.result, prepared.input);
          const base = implementation.verify(ctx, plan, data, delivery);
          return { accepted: base.accepted && digest(actual) === digest(prepared.result), reason: 'Public query, pinned source, complete receipt and result must match; no commerce fulfillment is asserted' };
        } catch {
          return { accepted: false, reason: 'Public-location result or source receipt does not match the permitted query' };
        }
      },
    };
  }

  permitted(owner: string): boolean {
    return this.allowedQueries.size > 0 && owner === JSON.stringify(['local-development', 'local', 'developer']);
  }
  private requireOwner(owner: string): void {
    if (!this.permitted(owner)) throw new DomainError('FORBIDDEN', 'Public-location discovery is not enabled for this identity');
  }
  private allowedInput(value: unknown): PublicGeoQuery {
    const parsed = inputSchema.safeParse(value);
    if (!parsed.success) throw new DomainError('INVALID_INPUT', 'Public-location discovery accepts only city and keyword');
    if (!this.allowedQueries.has(digest(parsed.data))) throw new DomainError('FORBIDDEN', 'This public query has not been permitted by trusted configuration');
    return parsed.data;
  }
  private checkedResult(value: unknown, input: PublicGeoQuery) {
    const parsed = resultSchema.safeParse(value);
    if (!parsed.success) throw new DomainError('CONFLICT', 'Public-location result has an invalid bounded schema');
    const result = parsed.data; const { ontologyReceipt: receipt, ...business } = result;
    if (!sameRef(receipt.capabilityRef, capability.ref) || !sameRef(receipt.ontologyRef, capability.ontologyRef)
      || receipt.tool !== 'ontology_geo_search' || receipt.inputDigest !== digest(input) || receipt.resultDigest !== digest(business)
      || digest(receipt.sourceCalls) !== digest(['search_poi'])) throw new DomainError('CONFLICT', 'Public-location receipt does not prove the exact read-only query');
    const observedAt = Date.parse(receipt.observedAt); const now = Date.now();
    if (observedAt > now || observedAt + 300000 <= now) throw new DomainError('CONFLICT', 'Public-location receipt is expired or has an invalid observation time');
    return result;
  }
  private checkedPreparation(ctx: AdapterContext, plan: import('../core/catalog.js').AdapterPlan, data: unknown) {
    this.requireOwner(ctx.owner);
    const payload = z.object({ query: querySchema, result: z.unknown() }).strict().parse(data);
    const { action: _action, ...query } = payload.query; const input = this.allowedInput(query);
    const boundRef = 'sourcePlan' in plan ? { id: `${binding.ref.id}.atomic`, version: '1' } : binding.ref;
    if (plan.steps.length !== 1 || digest(plan.steps[0]!.input) !== digest(input)
      || !sameRef(plan.bindingRef, boundRef)
      || !plan.bindingSnapshots.some(snapshot => sameRef(snapshot.ref, boundRef) && snapshot.configurationDigest === this.configurationDigest)) {
      throw new DomainError('CONFLICT', 'Public-location result is not bound to this plan and source configuration');
    }
    return { input, result: this.checkedResult(payload.result, input) };
  }

  async discover(ctx: AdapterContext, input: unknown, signal: AbortSignal) {
    this.requireOwner(ctx.owner);
    const query = this.allowedInput(input);
    const preparation: Preparation = await this.adapter.prepare(ctx, query, signal);
    signal.throwIfAborted();
    if (preparation.kind !== 'ready') throw new DomainError('CONFLICT', 'Public-location query did not produce a verified result');
    const payload = preparation.privateData as { result: unknown };
    const result = this.checkedResult(payload.result, query); const receipt = result.ontologyReceipt;
    const coverage: DiscoveryCoverage = {
      sourceId: this.id, status: result.places.length ? 'returned' : 'empty', queriedAt: receipt.observedAt,
      returnedStores: 0, queriedStores: 0, hasMore: true, realSupply: false,
      note: `Public-location query returned ${result.places.length} places. Provider result completeness is unknown; no merchant supply, price, stock or fulfillment was queried.`,
    };
    preparation.details = { ...preparation.details,
      evidenceKind: receipt.evidenceKind === 'fixture' ? 'fixture' : 'live_public_location_read',
      discoveryScope: 'public_locations_only', placeCount: result.places.length,
    };
    preparation.observedAt = receipt.observedAt;
    preparation.expiresAt = new Date(Date.parse(receipt.observedAt) + 300000).toISOString();
    return { coverage, candidates: result.places.length ? [{
      binding: { ...binding, configurationDigest: this.configurationDigest,
        verification: { level: receipt.evidenceKind === 'fixture' ? 'local_test' as const : 'read_only_probe' as const, evidenceRefs: [receipt.id] },
        discovery: { sourceId: this.id, requestId: ctx.request.id, requestRevision: ctx.request.revision, observedAt: receipt.observedAt, evidenceRefs: [receipt.id] },
      }, preparation,
    }] : [] };
  }
}
