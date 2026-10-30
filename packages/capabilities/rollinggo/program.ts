import { objectResultProjection } from '../../core/composed-actions.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BusinessFactProjection, businessFactsEnabled, sourceEntityRef } from '../../ontology/business-fact-projection.js';
import { digest } from '../../core/delegation.js';
import { DomainError } from '../../core/domain.js';
import { permitsPersonalSource } from '../../core/source-owner.js';
import type {
  AgentProgram,
  AgentProgramContext,
  AgentActionContext,
  AgentActionResult,
} from '../../core/agent-program.js';
import type {
  ServiceCapability,
  ServiceRequest,
} from '../../ontology/execution.js';
import type { OntologyObjectStore } from '../../ontology/object-store.js';
import { linkSnapshotDigest } from '../../ontology/object-store.js';
import { objectRefSchema, type ObjectRef } from '../../ontology/model.js';
import type { PlanningSnapshot } from '../../ontology/planning-contract.js';
import {
  rollingGoActionSchema,
  rollingGoActions,
  rollingGoModule,
  rollingGoObservationSchema,
  checkedRollingGo,
} from '../../ontology/rollinggo.js';
import {
  ONTOLOGY_READ_GUIDANCE,
  resolveOntologyMcpRead,
} from '../../ontology/mcp-read.js';
import { RollingGoSearchConnector, rollingGoInputSchema } from './connector.js';
const eq = (a: unknown, b: unknown) => digest(a) === digest(b);
const fail = (s: string): never => {
  throw new DomainError('CONFLICT', s);
};
const completion = z.strictObject({
  observation: objectRefSchema,
  rationale: z.string().min(1).max(2000),
});
export interface RollingGoOptions {
  keyFile: string;
  keySha256: string;
  connector?: Pick<RollingGoSearchConnector, 'search'>;
  evidenceKind?: 'fixture';
}
export class RollingGoProgram implements AgentProgram {
  readonly ref = { id: 'hotel.search.query', version: '1' };
  readonly actionIds = ['SearchRollingGoHotels'];
  readonly projectionTypes = [
    'RollingGoSearchTask',
    'RollingGoSearchObservation',
    'SourceReceipt',
    'HotelProperty', 'HotelPrice', 'Provider', 'Place',
  ];
  readonly guidance = ONTOLOGY_READ_GUIDANCE;
  readonly completionSchema = z.toJSONSchema(completion);
  readonly configurationDigest: string;
  private source: Pick<RollingGoSearchConnector, 'search'>;
  constructor(private options: RollingGoOptions) {
    this.source =
      options.connector ??
      new RollingGoSearchConnector(options.keyFile, options.keySha256);
    this.configurationDigest = digest({
      keyFile: options.keyFile,
      keySha256: options.keySha256,
      module: rollingGoModule,
      evidenceKind: options.evidenceKind ?? 'live_readonly',
    });
  }
  permitted(owner: string) {
    return permitsPersonalSource(this, owner);
  }
  capability(): ServiceCapability {
    return {
      ref: this.ref,
      ontologyRef: { id: rollingGoModule.id, version: rollingGoModule.version },
      name: 'RollingGo 酒店搜索',
      description:
        'Search hotels using explicit place, placeType, checkInParam (future checkInDate, stayNights, adultCount), localeParam (currency and language), originQuery and size. Preserve user dates, occupancy and currency; clarify missing criteria. Searches one room for adults only; additional rooms or children require another supported capability. Returns reference prices and hotel information only. Cannot book, order or pay.',
      tags: ['hotel', 'rollinggo', 'read-only'],
      environment: this.options.evidenceKind ? 'sandbox' : 'live',
      completion: 'artifact',
      inputSchema: z.toJSONSchema(rollingGoInputSchema),
      actions: this.actionIds.map((id) => ({
        ref: { id, version: '1' },
        effect: 'read',
      })),
      verifierRef: { id: 'rollinggo.search.source-readback', version: '1' },
      ontology: {
        objects: [
          'RollingGoSearchTask',
          'RollingGoSearchObservation',
          'SourceReceipt',
        ],
      },
      predicates: [
        {
          id: 'hotel.search_observed',
          description:
            'Exact source-backed hotel search returned, including no results',
        },
        { id: 'execution.no_order', description: 'No booking or payment' },
      ],
      outcomePredicates: ['hotel.search_observed'],
      goalOutcomes: [
        {
          predicate: 'hotel.search_observed',
          phase: 'fact',
          description:
            'Hotel search observed; prices and availability not guaranteed',
        },
      ],
      effectConstraints: [
        {
          predicate: 'execution.no_order',
          allowedEffects: ['read', 'local', 'object_write'],
        },
      ],
    };
  }
  initialize(
    graph: OntologyObjectStore,
    owner: string,
    request: ServiceRequest,
    value: unknown,
    component?: { id: string; scopeKey: string },
  ) {
    if (!this.permitted(owner))
      throw new DomainError('FORBIDDEN', 'RollingGo source is private');
    const input = rollingGoInputSchema.parse(value),
      root = { type: 'ServiceRequest', id: request.id },
      scope = {
        type: 'RollingGoSearchTask',
        id: digest({
          request: request.id,
          revision: request.revision,
          input,
          configuration: this.configurationDigest,
          component,
        }),
      };
    if (graph.read(owner, root).properties.revision !== request.revision)
      fail('Request revision changed');
    graph.ingest(
      owner,
      {
        objects: [
          {
            ref: scope,
            properties: {
              id: scope.id,
              displayTitle: 'RollingGo hotel search',
              requestRevision: request.revision,
              input,
              allowedActions: [...this.actionIds],
              configurationDigest: this.configurationDigest,
            },
          },
        ],
        links: [{ type: 'RollingGoTaskRequest', from: scope, to: root }],
      },
      { kind: 'task', id: request.id, observedAt: new Date().toISOString() },
    );
    return { scope, input };
  }
  schema(action: string) {
    if (action !== 'SearchRollingGoHotels') fail('Unregistered hotel action');
    return rollingGoActionSchema;
  }
  definition(graph: OntologyObjectStore, action: string) {
    this.schema(action);
    const def = graph.model.action(action),
      expected = rollingGoActions[0]!;
    if (!eq(def.read, expected.read)) fail('RollingGo action binding changed');
    return def;
  }
  private scope(ctx: AgentProgramContext) {
    if (
      !this.permitted(ctx.owner) ||
      !eq(ctx.state.programRef, this.ref) ||
      ctx.state.programDigest !== this.configurationDigest ||
      ctx.state.requestRevision !== ctx.request.revision
    )
      fail('RollingGo execution scope changed');
    const scope = ctx.graph.read(ctx.owner, ctx.state.scope),
      roots = ctx.graph.related(ctx.owner, scope.ref, 'request', {
        remaining: 1000,
      }),
      input = rollingGoInputSchema.parse(ctx.state.input);
    if (
      scope.ref.type !== 'RollingGoSearchTask' ||
      scope.properties.configurationDigest !== this.configurationDigest ||
      scope.properties.requestRevision !== ctx.request.revision ||
      !eq(scope.properties.input, input) ||
      !eq(scope.properties.allowedActions, this.actionIds) ||
      roots?.length !== 1 ||
      roots[0]!.ref.id !== ctx.request.id
    )
      fail('Hotel scope belongs to another task');
    return input;
  }
  validate(
    ctx: AgentProgramContext,
    action: string,
    value: Record<string, unknown>,
  ) {
    this.scope(ctx);
    this.definition(ctx.graph, action);
    const v = this.schema(action).parse(value);
    if (!eq(v, value) || !eq(v.scope, ctx.state.scope))
      fail('Hotel action escaped its scope');
  }
  async invoke(
    ctx: AgentActionContext,
    action: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<AgentActionResult> {
    this.validate(ctx, action, input);
    if (!ctx.modelRunId || ctx.callerRequestId)
      fail('Hotel search requires an original model plan');
    const args = this.scope(ctx),
      resolved = resolveOntologyMcpRead(
        this.definition(ctx.graph, action).read!.mcp!,
        input,
        args,
        () => fail('Unexpected dependency'),
      );
    if (
      resolved.server !== 'rollinggo' ||
      resolved.tool !== 'searchHotels' ||
      !eq(resolved.args, args)
    )
      fail('Hotel mapping changed');
    const result = await this.source.search(args, signal);
    signal.throwIfAborted();
    this.scope(ctx);
    const id = randomUUID(),
      body = {
        id,
        requestId: ctx.request.id,
        requestRevision: ctx.request.revision,
        configurationDigest: this.configurationDigest,
        scope: ctx.state.scope,
        actionInput: input,
        planId: ctx.planId,
        intentId: ctx.intentId,
        attemptId: ctx.attemptId,
        modelRunId: ctx.modelRunId,
        input: args,
        hotels: result.hotels,
        observedAt: result.observedAt,
        expiresAt: new Date(
          Date.parse(result.observedAt) + 300000,
        ).toISOString(),
        evidenceKind: this.options.evidenceKind ?? 'live_readonly',
      };
    return {
      value: checkedRollingGo({ ...body, contentDigest: digest(body) }),
      evidenceRefs: [id],
    };
  }
  project(
    ctx: AgentActionContext,
    action: string,
    input: Record<string, unknown>,
    result: AgentActionResult,
  ): ObjectRef {
    this.validate(ctx, action, input);
    const s = checkedRollingGo(result.value);
    if (
      s.requestId !== ctx.request.id ||
      s.requestRevision !== ctx.request.revision ||
      s.configurationDigest !== this.configurationDigest ||
      !eq(s.scope, ctx.state.scope) ||
      !eq(s.input, this.scope(ctx)) ||
      !eq(s.actionInput, input) ||
      s.planId !== ctx.planId ||
      s.intentId !== ctx.intentId ||
      s.attemptId !== ctx.attemptId ||
      s.modelRunId !== ctx.modelRunId ||
      s.evidenceKind !== (this.options.evidenceKind ?? 'live_readonly') ||
      !eq(result.evidenceRefs, [s.id]) ||
      Date.parse(s.expiresAt) <= ctx.graph.now()
    )
      fail('Hotel result provenance differs from accepted attempt');
    const ref = { type: 'RollingGoSearchObservation', id: s.id },
      receipt = { type: 'SourceReceipt', id: `rollinggo:${s.id}` },
      root = { type: 'ServiceRequest', id: s.requestId },
      properties = {
        id: s.id,
        displayTitle: 'RollingGo hotel search result',
        requestRevision: s.requestRevision,
        snapshot: s,
      };
    const links = [
      { type: 'RollingGoObservationrequest', from: ref, to: root },
      { type: 'RollingGoObservationscope', from: ref, to: s.scope },
      { type: 'ReceiptRequest', from: receipt, to: root },
    ];
    const facts = businessFactsEnabled(ctx.graph) ? new BusinessFactProjection(ctx.graph, ctx.owner, s.observedAt, receipt, { query: s.scope, collection: 'rollingGoResults', observation: ref }) : undefined;
    if (facts) {
      const provider = facts.entity(sourceEntityRef('Provider', 'rollinggo:international', 'rollinggo'), 'RollingGo', { name: 'RollingGo', verifiedIdentityRefs: ['https://mcp.rollinggo.ai/mcp'] });
      for (const hotel of s.hotels) {
        const title = hotel.name || hotel.nameEn || `RollingGo hotel ${hotel.hotelId}`;
        const entity = facts.entity(sourceEntityRef('HotelProperty', 'rollinggo:international', String(hotel.hotelId)), title,
          { sourceId: String(hotel.hotelId), ...(hotel.name || hotel.nameEn ? { hotelName: title } : {}), ...(hotel.address ? { address: hotel.address } : {}) }, 'HotelPropertyEvidence');
        facts.edge('RollingGoObservationHotels', ref, entity);
        if (hotel.address) {
          const location = facts.entity(sourceEntityRef('Place', 'rollinggo:international', { hotel: hotel.hotelId, address: hotel.address }), title,
            { name: title, address: { text: hotel.address } }, 'PlaceEvidence');
          facts.replaceLink('HotelPropertyLocation', entity, location);
        }
        if (hotel.price) {
          const amount = hotel.price.hasPrice && hotel.price.lowestPrice !== undefined ? String(hotel.price.lowestPrice) : undefined;
          const price = facts.fact(sourceEntityRef('HotelPrice', 'rollinggo:international', { observation: s.id, hotel: hotel.hotelId }), title,
            { observedAt: s.observedAt, expiresAt: s.expiresAt, requestRevision: s.requestRevision, hotelRevision: facts.revision(entity), checkInDate: s.input.checkInParam.checkInDate, stayNights: s.input.checkInParam.stayNights,
              adultCount: s.input.checkInParam.adultCount, hasPrice: hotel.price.hasPrice, amountUnit: 'major', priceKind: 'reference', priceBasis: 'unknown', pricingCompleteness: 'unknown',
              ...(amount !== undefined && /^(0|[1-9]\d{0,17})(\.\d{1,6})?$/.test(amount) ? { referenceAmount: amount } : {}),
              ...(hotel.price.currency && /^[A-Z]{3}$/.test(hotel.price.currency) ? { currency: hotel.price.currency } : {}) });
          facts.edge('RollingGoObservationPrices', ref, price); facts.edge('HotelPriceHotel', price, entity);
          facts.edge('HotelPriceProvider', price, provider); facts.edge('HotelPriceRequest', price, root);
        }
      }
      links.push(...facts.links);
    }
    ctx.graph.ingest(
      ctx.owner,
      {
        objects: [
          { ref, properties },
          ...(facts?.objects ?? []),
          {
            ref: receipt,
            properties: {
              receiptId: receipt.id,
              displayTitle: 'RollingGo search receipt',
              sourceIdentity: 'rollinggo-mcp:international',
              sourceEventId: s.id,
              scope: 'domain_hotel',
              observedAt: s.observedAt,
              evidenceLevel:
                s.evidenceKind === 'fixture' ? 'synthetic' : 'live_readonly',
              contentDigest: s.contentDigest,
              subjects: [
                ...(facts?.subjects() ?? []),
                {
                  object: ref,
                  digest: digest(properties),
                  linksDigest: linkSnapshotDigest(ref, links),
                },
              ],
              safeSummary: 'Hotel reference prices only; no order or payment',
            },
          },
        ],
        removeLinks: facts?.removeLinks,
        links: [
          ...links,
          {
            type: 'RollingGoObservationsourceReceipts',
            from: ref,
            to: receipt,
          },
        ],
      },
      {
        kind: s.evidenceKind === 'fixture' ? 'synthetic' : 'provider',
        id: s.id,
        observedAt: s.observedAt,
        ...(facts?.readContext ? { readContext: facts.readContext } : {}),
      },
    );
    return ref;
  }
  projectOutputs(
    _ctx: AgentActionContext,
    _action: string,
    _input: Record<string, unknown>,
    result: AgentActionResult,
    object: ObjectRef,
  ) {
    const s = checkedRollingGo(result.value);
    return objectResultProjection(
      object,
      {
        origin: s.evidenceKind === 'fixture' ? 'synthetic' : 'provider',
        refs: result.evidenceRefs,
        observedAt: s.observedAt,
        expiresAt: s.expiresAt,
      },
      false,
      true,
    );
  }
  validateOutput(
    ctx: AgentProgramContext,
    output: import('../../ontology/composition-contract.js').AcceptedPortValue,
  ) {
    for (const ref of (output.definition.cardinality === 'many'
      ? output.value
      : [output.value]) as ObjectRef[])
      this.observation(ctx, ref);
  }
  private observation(ctx: AgentProgramContext, ref: ObjectRef) {
    this.scope(ctx);
    if (!ctx.state.observations.some((r) => eq(r, ref)))
      fail('Hotel observation not accepted by this task');
    const status = ctx.graph.evaluate(ctx.owner, {
      function: 'rollingGoSearchStatus',
      object: ref,
    });
    if (status.status !== 'known')
      fail(status.reason ?? 'Hotel evidence unknown');
    const s = checkedRollingGo(
      ctx.graph.read(ctx.owner, ref).properties.snapshot,
    );
    if (
      s.configurationDigest !== this.configurationDigest ||
      s.requestId !== ctx.request.id ||
      !eq(s.input, this.scope(ctx)) ||
      !eq(s.scope, ctx.state.scope)
    )
      fail('Hotel source scope changed');
    return s;
  }
  complete(ctx: AgentProgramContext, value: unknown, reads: PlanningSnapshot) {
    const c = completion.parse(value),
      s = this.observation(ctx, c.observation),
      args = { function: 'rollingGoSearchStatus', object: c.observation },
      status = ctx.graph.evaluate(ctx.owner, args);
    if (
      !reads.objects.some((r) => eq(r.ref, c.observation)) ||
      !reads.reads.some(
        (r) =>
          r.tool === 'evaluate_ontology' &&
          r.status === 'ok' &&
          r.inputDigest === digest(args) &&
          r.outputDigest === digest(status),
      )
    )
      fail('Read and evaluate hotel evidence before completion');
    const later = ctx.state.observations.slice(
      ctx.state.observations.findIndex((r) => eq(r, c.observation)) + 1,
    );
    if (
      later.some(
        (r) =>
          !eq(
            checkedRollingGo(ctx.graph.read(ctx.owner, r).properties.snapshot)
              .hotels,
            s.hotels,
          ),
      )
    )
      fail('Later hotel search changed the results');
    return {
      evidenceLevel:
        s.evidenceKind === 'fixture'
          ? ('synthetic' as const)
          : ('live_readonly' as const),
      artifact: {
        id: randomUUID(),
        name: 'rollinggo-search-result.json',
        data: {
          goal: ctx.request.originalGoal,
          deliverable: '酒店搜索已完成；价格为查询时参考价，未下单或付款。',
          execution: 'completed' as const,
          result: {
            rollingGoAnswer: {
              ...s,
              priceKind: 'reference',
              providerExpiry: 'unknown',
              noBusinessWrites: true,
            },
          },
        },
      },
      facts: { conditions: ['hotel.search_observed', 'execution.no_order'] },
      evidenceRefs: [s.id],
    };
  }
}
