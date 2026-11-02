import { objectResultProjection } from '../../core/composed-actions.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BusinessFactProjection, sourceEntityRef } from '../../ontology/business-fact-projection.js';
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
  fliggyActionSchema,
  fliggyActions,
  fliggyModule,
  checkedFliggy,
} from '../../ontology/fliggy.js';
import {
  ONTOLOGY_READ_GUIDANCE,
  resolveOntologyMcpRead,
} from '../../ontology/mcp-read.js';
import { FliggyConnector, FLIGGY_CLI_VERSION, FLIGGY_CLI_SHA256, type FliggyCredential } from './connector.js';
import { fliggyInputSchema, fliggyArguments, fliggyActions as sourceActions, validateFliggyInput } from './contracts.js';
const eq = (a: unknown, b: unknown) => digest(a) === digest(b);
const fail = (s: string): never => {
  throw new DomainError('CONFLICT', s);
};
const completion = z.strictObject({
  observation: objectRefSchema,
  rationale: z.string().min(1).max(2000),
});
export type FliggyOptions = FliggyCredential & { connector?: Pick<FliggyConnector, 'search'>; evidenceKind?: 'fixture' };
export class FliggyProgram implements AgentProgram {
  readonly ref = { id: 'fliggy.travel.search', version: '1' };
  readonly actionIds = Object.values(sourceActions).map(value => value.action);
  readonly projectionTypes = [
    'FliggySearchTask',
    'FliggySearchObservation',
    'SourceReceipt',
    'HotelProperty', 'TravelProduct', 'FliggyTravelOption', 'Provider',
  ];
  readonly guidance = ONTOLOGY_READ_GUIDANCE;
  readonly completionSchema = z.toJSONSchema(completion);
  readonly configurationDigest: string;
  private source: Pick<FliggyConnector, 'search'>;
  constructor(private options: FliggyOptions) {
    this.source =
      options.connector ??
      new FliggyConnector(options);
    this.configurationDigest = digest({
      keyFile: options.keyFile,
      keySha256: options.keySha256,
      module: fliggyModule, mode: options.mode, cliVersion: FLIGGY_CLI_VERSION, cliSha256: FLIGGY_CLI_SHA256,
      evidenceKind: options.evidenceKind ?? 'live_readonly',
    });
  }
  permitted(owner: string) {
    return permitsPersonalSource(this, owner);
  }
  capability(): ServiceCapability {
    return {
      ref: this.ref,
      ontologyRef: { id: fliggyModule.id, version: fliggyModule.version },
      name: '飞猪 FlyAI 机票、酒店与万豪套餐查询',
      description: 'Search FlyAI flights, hotels, Marriott hotels or Marriott packages. Use explicit dates and destinations for flight/travel searches, clarify missing criteria, preserve exact filters. Results are partial source discovery and may contain masked or FROM prices. Package itemId is a product/SPU, not an observed SKU. A keyword is not a strict geographic filter. Room type, date availability, package composition and total mandatory costs require independent source evidence before comparison. Commission percentages and settled rewards are unknown; trial queries earn no commission. Cannot book, pay, issue tickets or redeem a package.',
      tags: ['fliggy', 'flyai', 'flight', 'hotel', 'package', 'read-only'],
      environment: this.options.evidenceKind ? 'sandbox' : 'live',
      completion: 'artifact',
      inputSchema: z.toJSONSchema(fliggyInputSchema),
      actions: this.actionIds.map((id) => ({
        ref: { id, version: '1' },
        effect: 'read',
      })),
      verifierRef: { id: 'fliggy.search.source-readback', version: '1' },
      ontology: {
        objects: [
          'FliggySearchTask',
          'FliggySearchObservation',
          'SourceReceipt',
        ],
      },
      predicates: [
        {
          id: 'fliggy.search_observed',
          description:
            'Exact source-backed travel search returned, including no results',
        },
        { id: 'execution.no_order', description: 'No booking or payment' },
      ],
      outcomePredicates: ['fliggy.search_observed'],
      goalOutcomes: [
        {
          predicate: 'fliggy.search_observed',
          phase: 'fact',
          description:
            'Travel search observed; prices and availability not guaranteed',
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
      throw new DomainError('FORBIDDEN', 'Fliggy source is private');
    const input = fliggyInputSchema.parse(value),
      root = { type: 'ServiceRequest', id: request.id },
      scope = {
        type: 'FliggySearchTask',
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
              displayTitle: 'Fliggy travel search',
              requestRevision: request.revision,
              input,
              allowedActions: [...this.actionIds],
              configurationDigest: this.configurationDigest,
            },
          },
        ],
        links: [{ type: 'FliggyTaskRequest', from: scope, to: root }],
      },
      { kind: 'task', id: request.id, observedAt: new Date().toISOString() },
    );
    return { scope, input };
  }
  schema(action: string) {
    if (!this.actionIds.includes(action as typeof this.actionIds[number])) fail('Unregistered travel action');
    return fliggyActionSchema;
  }
  definition(graph: OntologyObjectStore, action: string) {
    this.schema(action);
    const def = graph.model.action(action),
      expected = fliggyActions.find(value => value.id === action)!;
    if (!eq(def.read, expected.read)) fail('Fliggy action binding changed');
    return def;
  }
  private scope(ctx: AgentProgramContext) {
    if (
      !this.permitted(ctx.owner) ||
      !eq(ctx.state.programRef, this.ref) ||
      ctx.state.programDigest !== this.configurationDigest ||
      ctx.state.requestRevision !== ctx.request.revision
    )
      fail('Fliggy execution scope changed');
    const scope = ctx.graph.read(ctx.owner, ctx.state.scope),
      roots = ctx.graph.related(ctx.owner, scope.ref, 'request', {
        remaining: 1000,
      }),
      input = fliggyInputSchema.parse(ctx.state.input);
    if (
      scope.ref.type !== 'FliggySearchTask' ||
      scope.properties.configurationDigest !== this.configurationDigest ||
      scope.properties.requestRevision !== ctx.request.revision ||
      !eq(scope.properties.input, input) ||
      !eq(scope.properties.allowedActions, this.actionIds) ||
      roots?.length !== 1 ||
      roots[0]!.ref.id !== ctx.request.id
    )
      fail('Travel scope belongs to another task');
    return input;
  }
  validate(
    ctx: AgentProgramContext,
    action: string,
    value: Record<string, unknown>,
  ) {
    const criteria = this.scope(ctx);
    if (sourceActions[criteria.kind].action !== action) fail('Fliggy action differs from the exact query kind');
    this.definition(ctx.graph, action);
    const v = this.schema(action).parse(value);
    if (!eq(v, value) || !eq(v.scope, ctx.state.scope))
      fail('Travel action escaped its scope');
  }
  async invoke(
    ctx: AgentActionContext,
    action: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<AgentActionResult> {
    this.validate(ctx, action, input);
    if (!ctx.modelRunId || ctx.callerRequestId)
      fail('Travel search requires an original model plan');
    const args = this.scope(ctx);
    validateFliggyInput(args, ctx.graph.now());
    const parameters = fliggyArguments(args),
      resolved = resolveOntologyMcpRead(
        this.definition(ctx.graph, action).read!.mcp!,
        input,
        { criteria: parameters },
        () => fail('Unexpected dependency'),
      );
    if (
      resolved.server !== 'fliggy-flyai' ||
      resolved.tool !== sourceActions[args.kind].tool ||
      !eq(resolved.args, parameters)
    )
      fail('Travel mapping changed');
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
        data: result.data,
        observedAt: result.observedAt,
        expiresAt: new Date(
          Date.parse(result.observedAt) + 300000,
        ).toISOString(),
        evidenceKind: this.options.evidenceKind ?? 'live_readonly',
      };
    return {
      value: checkedFliggy({ ...body, contentDigest: digest(body) }),
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
    const s = checkedFliggy(result.value);
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
      fail('Travel result provenance differs from accepted attempt');
    const ref = { type: 'FliggySearchObservation', id: s.id },
      receipt = { type: 'SourceReceipt', id: `fliggy:${s.id}` },
      root = { type: 'ServiceRequest', id: s.requestId },
      properties = {
        id: s.id,
        displayTitle: 'Fliggy travel search result',
        requestRevision: s.requestRevision,
        snapshot: s,
      };
    const links = [
      { type: 'FliggyObservationrequest', from: ref, to: root },
      { type: 'FliggyObservationscope', from: ref, to: s.scope },
      { type: 'ReceiptRequest', from: receipt, to: root },
    ];
    const facts = new BusinessFactProjection(ctx.graph, ctx.owner, s.observedAt, receipt, { query: s.scope, collection: 'fliggyResults', observation: ref });
    const provider = facts.entity(sourceEntityRef('Provider', 'fliggy:flyai', 'fliggy'), '飞猪 FlyAI', { name: '飞猪 FlyAI', verifiedIdentityRefs: ['https://flyai.open.fliggy.com/'] });
    for (const [index, item] of s.data.items.entries()) {
      const title = item.kind === 'flight' ? item.offer.journeys[0]!.segments[0]!.marketingTransportNo : item.kind === 'marriottPackage' ? item.offer.title : item.offer.name;
      const option = facts.fact(sourceEntityRef('FliggyTravelOption','fliggy:flyai',{ observation:s.id,index }),title,{
        observedAt:s.observedAt, expiresAt:s.expiresAt, requestRevision:s.requestRevision, kind:item.kind, data:item,
        criteria:s.input, priceKind:'reference', comparisonStatus:'unverified', commissionRate:'unknown', commissionSettlement:'unknown',
      });
      facts.edge('FliggyObservationOptions',ref,option); facts.edge('FliggyTravelOptionRequest',option,root); facts.edge('FliggyTravelOptionProvider',option,provider);
      if (item.kind === 'hotel' || item.kind === 'marriottHotel') {
        const hotel = facts.entity(sourceEntityRef('HotelProperty','fliggy:hotel',item.offer.sourceId),item.offer.name,{sourceId:item.offer.sourceId,hotelName:item.offer.name,...(item.offer.address?{address:item.offer.address}:{})},'HotelPropertyEvidence');
        facts.edge('FliggyTravelOptionHotel',option,hotel);
      } else if (item.kind === 'marriottPackage' && item.offer.itemId) {
        const product = facts.entity(sourceEntityRef('TravelProduct','fliggy:item',item.offer.itemId),item.offer.title,{sourceId:item.offer.itemId,name:item.offer.title,classification:'unknown'},'TravelProductEvidence');
        facts.edge('FliggyTravelOptionProduct',option,product);
      }
    }
    links.push(...facts.links);
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
              displayTitle: 'Fliggy search receipt',
              sourceIdentity: 'fliggy-flyai:mcp',
              sourceEventId: s.id,
              scope: 'domain_itinerary',
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
              safeSummary: 'Partial travel discovery; no confirmed SKU, reservation, payment or redemption',
            },
          },
        ],
        removeLinks: facts?.removeLinks,
        links: [
          ...links,
          {
            type: 'FliggyObservationsourceReceipts',
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
    const s = checkedFliggy(result.value);
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
      fail('Travel observation not accepted by this task');
    const status = ctx.graph.evaluate(ctx.owner, {
      function: 'fliggySearchStatus',
      object: ref,
    });
    if (status.status !== 'known')
      fail(status.reason ?? 'Travel evidence unknown');
    const s = checkedFliggy(
      ctx.graph.read(ctx.owner, ref).properties.snapshot,
    );
    if (
      s.configurationDigest !== this.configurationDigest ||
      s.requestId !== ctx.request.id ||
      !eq(s.input, this.scope(ctx)) ||
      !eq(s.scope, ctx.state.scope)
    )
      fail('Travel source scope changed');
    return s;
  }
  complete(ctx: AgentProgramContext, value: unknown, reads: PlanningSnapshot) {
    const c = completion.parse(value),
      s = this.observation(ctx, c.observation),
      args = { function: 'fliggySearchStatus', object: c.observation },
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
      fail('Read and evaluate travel evidence before completion');
    const later = ctx.state.observations.slice(
      ctx.state.observations.findIndex((r) => eq(r, c.observation)) + 1,
    );
    if (
      later.some(
        (r) =>
          !eq(
            checkedFliggy(ctx.graph.read(ctx.owner, r).properties.snapshot)
              .data,
            s.data,
          ),
      )
    )
      fail('Later travel search changed the results');
    return {
      evidenceLevel:
        s.evidenceKind === 'fixture'
          ? ('synthetic' as const)
          : ('live_readonly' as const),
      artifact: {
        id: randomUUID(),
        name: 'fliggy-search-result.json',
        data: {
          goal: ctx.request.originalGoal,
          deliverable: '飞猪查询已完成；结果为部分来源候选，起价和模糊价格不是已确认 SKU 总价，未预订、付款或核销。',
          execution: 'completed' as const,
          result: {
            fliggyAnswer: {
              ...s,
              priceKind: 'reference',
              providerExpiry: 'unknown',
              noBusinessWrites: true,
            },
          },
        },
      },
      facts: { conditions: ['fliggy.search_observed', 'execution.no_order'] },
      evidenceRefs: [s.id],
    };
  }
}
