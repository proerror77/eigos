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
  rollingGoFlightActionSchema,
  rollingGoFlightActions,
  rollingGoFlightModule,
  checkedRollingGoFlight,
} from '../../ontology/rollinggo-flight.js';
import {
  ONTOLOGY_READ_GUIDANCE,
  resolveOntologyMcpRead,
} from '../../ontology/mcp-read.js';
import { RollingGoFlightConnector } from './connector.js';
import { flightInputSchema, flightAction, flightArguments, validateFlightDates } from './contracts.js';
const eq = (a: unknown, b: unknown) => digest(a) === digest(b);
const fail = (s: string): never => {
  throw new DomainError('CONFLICT', s);
};
const completion = z.strictObject({
  observation: objectRefSchema,
  rationale: z.string().min(1).max(2000),
});
export interface RollingGoFlightOptions {
  keyFile: string;
  keySha256: string;
  connector?: Pick<RollingGoFlightConnector, 'search'>;
  evidenceKind?: 'fixture';
}
export class RollingGoFlightProgram implements AgentProgram {
  readonly ref = { id: 'flight.search.query', version: '1' };
  readonly actionIds = ['SearchRollingGoAirports', 'SearchRollingGoOneWayFlights', 'SearchRollingGoRoundTripFlights'];
  readonly projectionTypes = [
    'RollingGoFlightTask',
    'RollingGoFlightObservation',
    'SourceReceipt',
    'Airport', 'FlightSegment', 'FlightFare', 'Provider',
  ];
  readonly guidance = ONTOLOGY_READ_GUIDANCE;
  readonly completionSchema = z.toJSONSchema(completion);
  readonly configurationDigest: string;
  private source: Pick<RollingGoFlightConnector, 'search'>;
  constructor(private options: RollingGoFlightOptions) {
    this.source =
      options.connector ??
      new RollingGoFlightConnector(options.keyFile, options.keySha256);
    this.configurationDigest = digest({
      keyFile: options.keyFile,
      keySha256: options.keySha256,
      module: rollingGoFlightModule,
      evidenceKind: options.evidenceKind ?? 'live_readonly',
    });
  }
  permitted(owner: string) {
    return permitsPersonalSource(this, owner);
  }
  capability(): ServiceCapability {
    return {
      ref: this.ref,
      ontologyRef: { id: rollingGoFlightModule.id, version: rollingGoFlightModule.version },
      name: 'RollingGo 国内端点机场与机票查询',
      description: 'Read-only RollingGo domestic endpoint. kind=airports looks up city/airport codes by keyword (prefer English names or IATA). kind=flights searches explicit city codes, dates, adults, children, cabin and ONE_WAY/ROUND_TRIP; round trips require retDate. Clarify missing criteria and preserve the exact route, dates, party and cabin. Airport lookup is a separate query; do not substitute an airport code for a city code. Provider availability and response schemas require live acceptance. Returns source reference prices only, never a booking, confirmed seats or a ticket. No payment or issuance.',
      tags: ['flight', 'airport', 'rollinggo', 'read-only'],
      environment: this.options.evidenceKind ? 'sandbox' : 'live',
      completion: 'artifact',
      inputSchema: z.toJSONSchema(flightInputSchema),
      actions: this.actionIds.map((id) => ({
        ref: { id, version: '1' },
        effect: 'read',
      })),
      verifierRef: { id: 'rollinggo.flight.source-readback', version: '1' },
      ontology: {
        objects: [
          'RollingGoFlightTask',
          'RollingGoFlightObservation',
          'SourceReceipt',
        ],
      },
      predicates: [
        {
          id: 'flight.search_observed',
          description:
            'Exact source-backed flight search returned, including no results',
        },
        { id: 'execution.no_order', description: 'No booking or payment' },
      ],
      outcomePredicates: ['flight.search_observed'],
      goalOutcomes: [
        {
          predicate: 'flight.search_observed',
          phase: 'fact',
          description:
            'Flight search observed; prices and availability not guaranteed',
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
    const input = flightInputSchema.parse(value),
      root = { type: 'ServiceRequest', id: request.id },
      scope = {
        type: 'RollingGoFlightTask',
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
              displayTitle: 'RollingGo flight search',
              requestRevision: request.revision,
              input,
              allowedActions: [...this.actionIds],
              configurationDigest: this.configurationDigest,
            },
          },
        ],
        links: [{ type: 'RollingGoFlightTaskRequest', from: scope, to: root }],
      },
      { kind: 'task', id: request.id, observedAt: new Date().toISOString() },
    );
    return { scope, input };
  }
  schema(action: string) {
    if (!this.actionIds.includes(action)) fail('Unregistered flight action');
    return rollingGoFlightActionSchema;
  }
  definition(graph: OntologyObjectStore, action: string) {
    this.schema(action);
    const def = graph.model.action(action),
      expected = rollingGoFlightActions.find(a => a.id === action)!;
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
      input = flightInputSchema.parse(ctx.state.input);
    if (
      scope.ref.type !== 'RollingGoFlightTask' ||
      scope.properties.configurationDigest !== this.configurationDigest ||
      scope.properties.requestRevision !== ctx.request.revision ||
      !eq(scope.properties.input, input) ||
      !eq(scope.properties.allowedActions, this.actionIds) ||
      roots?.length !== 1 ||
      roots[0]!.ref.id !== ctx.request.id
    )
      fail('Flight scope belongs to another task');
    return input;
  }
  validate(
    ctx: AgentProgramContext,
    action: string,
    value: Record<string, unknown>,
  ) {
    const requested = this.scope(ctx);
    if (action !== flightAction(requested)) fail('Flight action differs from the exact query kind');
    this.definition(ctx.graph, action);
    const v = this.schema(action).parse(value);
    if (!eq(v, value) || !eq(v.scope, ctx.state.scope))
      fail('Flight action escaped its scope');
  }
  async invoke(
    ctx: AgentActionContext,
    action: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<AgentActionResult> {
    this.validate(ctx, action, input);
    if (!ctx.modelRunId || ctx.callerRequestId)
      fail('Flight search requires an original model plan');
    const args = this.scope(ctx);
    validateFlightDates(args, ctx.graph.now());
    const parameters = flightArguments(args),
      resolved = resolveOntologyMcpRead(
        this.definition(ctx.graph, action).read!.mcp!,
        input,
        parameters,
        () => fail('Unexpected dependency'),
      );
    if (
      resolved.server !== 'rollinggo-flight' ||
      resolved.tool !== (args.kind === 'airports' ? 'searchAirports' : 'searchFlights') ||
      !eq(resolved.args, parameters)
    )
      fail('Flight mapping changed');
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
      value: checkedRollingGoFlight({ ...body, contentDigest: digest(body) }),
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
    const s = checkedRollingGoFlight(result.value);
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
      fail('Flight result provenance differs from accepted attempt');
    const ref = { type: 'RollingGoFlightObservation', id: s.id },
      receipt = { type: 'SourceReceipt', id: `rollinggo-flight:${s.id}` },
      root = { type: 'ServiceRequest', id: s.requestId },
      properties = {
        id: s.id,
        displayTitle: 'RollingGo flight search result',
        requestRevision: s.requestRevision,
        snapshot: s,
      };
    const links = [
      { type: 'RollingGoFlightObservationrequest', from: ref, to: root },
      { type: 'RollingGoFlightObservationscope', from: ref, to: s.scope },
      { type: 'ReceiptRequest', from: receipt, to: root },
    ];
    const facts = new BusinessFactProjection(ctx.graph, ctx.owner, s.observedAt, receipt, { query: s.scope, collection: 'rollingGoFlightResults', observation: ref });
    const provider = facts.entity(sourceEntityRef('Provider', 'rollinggo:domestic:flight', 'rollinggo'), 'RollingGo flight', { name: 'RollingGo', verifiedIdentityRefs: ['https://mcp.rollinggo.cn/mcp/flight'] });
    if (s.data.kind === 'airports') for (const airport of s.data.airports) {
      const entity = facts.entity(sourceEntityRef('Airport', 'rollinggo:domestic:flight', airport.airportCode), airport.airportName, airport, 'AirportEvidence');
      facts.edge('RollingGoFlightObservationAirports', ref, entity);
    }
    if (s.data.kind === 'flights') for (const [index, option] of s.data.flights.entries()) {
      const fare = facts.fact(sourceEntityRef('FlightFare', 'rollinggo:domestic:flight', { observation: s.id, index }), 'Flight reference fare', {
        observedAt: s.observedAt, expiresAt: s.expiresAt, requestRevision: s.requestRevision, criteria: s.input,
        sourceOption: option, priceKind: 'reference', priceBasis: 'unknown', pricingCompleteness: 'unknown', amountUnit: 'unknown',
      });
      facts.edge('RollingGoFlightObservationFares', ref, fare);
      facts.edge('FlightFareRequest', fare, root); facts.edge('FlightFareProvider', fare, provider);
      for (const [direction, segments] of [['Outbound', option.fromSegments], ['Return', option.retSegments ?? []]] as const) for (const segment of segments) {
        const entity = facts.entity(sourceEntityRef('FlightSegment', 'rollinggo:domestic:flight', segment), segment.flightNumber, segment, 'FlightSegmentEvidence');
        facts.edge(`FlightFare${direction}Segments`, fare, entity);
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
              displayTitle: 'RollingGo search receipt',
              sourceIdentity: 'rollinggo-mcp:domestic:flight',
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
              safeSummary: 'Flight reference prices only; no order or payment',
            },
          },
        ],
        removeLinks: facts?.removeLinks,
        links: [
          ...links,
          {
            type: 'RollingGoFlightObservationsourceReceipts',
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
    const s = checkedRollingGoFlight(result.value);
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
      fail('Flight observation not accepted by this task');
    const status = ctx.graph.evaluate(ctx.owner, {
      function: 'rollingGoFlightSearchStatus',
      object: ref,
    });
    if (status.status !== 'known')
      fail(status.reason ?? 'Flight evidence unknown');
    const s = checkedRollingGoFlight(
      ctx.graph.read(ctx.owner, ref).properties.snapshot,
    );
    if (
      s.configurationDigest !== this.configurationDigest ||
      s.requestId !== ctx.request.id ||
      !eq(s.input, this.scope(ctx)) ||
      !eq(s.scope, ctx.state.scope)
    )
      fail('Flight source scope changed');
    return s;
  }
  complete(ctx: AgentProgramContext, value: unknown, reads: PlanningSnapshot) {
    const c = completion.parse(value),
      s = this.observation(ctx, c.observation),
      args = { function: 'rollingGoFlightSearchStatus', object: c.observation },
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
      fail('Read and evaluate flight evidence before completion');
    const later = ctx.state.observations.slice(
      ctx.state.observations.findIndex((r) => eq(r, c.observation)) + 1,
    );
    if (
      later.some(
        (r) =>
          !eq(
            checkedRollingGoFlight(ctx.graph.read(ctx.owner, r).properties.snapshot)
              .data,
            s.data,
          ),
      )
    )
      fail('Later flight search changed the results');
    return {
      evidenceLevel:
        s.evidenceKind === 'fixture'
          ? ('synthetic' as const)
          : ('live_readonly' as const),
      artifact: {
        id: randomUUID(),
        name: 'rollinggo-flight-result.json',
        data: {
          goal: ctx.request.originalGoal,
          deliverable: '机场或航班查询已完成；票价为来源参考价，未预订、付款或出票。',
          execution: 'completed' as const,
          result: {
            rollingGoFlightAnswer: {
              ...s,
              priceKind: 'reference',
              providerExpiry: 'unknown',
              noBusinessWrites: true,
            },
          },
        },
      },
      facts: { conditions: ['flight.search_observed', 'execution.no_order'] },
      evidenceRefs: [s.id],
    };
  }
}
