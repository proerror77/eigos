import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { ActionAdapter, AdapterContext, Delivery, Preparation } from '../core/catalog.js';
import type { ActionContext, ActionResult } from '../ontology/actions.js';
import type { CandidateFacts, ExecutionPlan, PlanStep, ProviderBinding, ServiceCapability } from '../ontology/execution.js';
import { assessDomain, quoteRoleCriteria } from '../ontology/domain-rules.js';
import { domainCapabilityId, domainOptionSchema, domainSnapshotSchema, domainSourceEntitySchema, domainSourceRelationshipSchema, parseDomainResultResources, publicDomainEntities, type DomainSnapshot } from '../ontology/domain-projection.js';
import { domainRequirementRoles, domainResultSchemas, parseDomainParameters, serviceDomain, type ServiceDomain } from '../ontology/service-domains.js';

const operationSchema = z.object({ key: z.string().min(1).max(200), inputDigest: z.string().regex(/^[a-f0-9]{64}$/), eventId: z.string().min(1).max(200), version: z.number().int().positive(), observation: z.record(z.string(), z.unknown()), entities: z.array(domainSourceEntitySchema).max(40).optional(), relationships: z.array(domainSourceRelationshipSchema).max(60).optional() }).strict();
export type DomainOperation = z.infer<typeof operationSchema>;
/** Explicit test-provider injection only. No live endpoint or credential path exists. */
export interface DomainSandboxProvider {
  domain: ServiceDomain; id: string; configurationDigest: string; environment: 'sandbox';
  prepare(input: Record<string, unknown>, signal: AbortSignal): Promise<{ option: z.infer<typeof domainOptionSchema>; entities?: DomainSnapshot['entities']; relationships?: DomainSnapshot['relationships'] }>;
  submit(key: string, input: Record<string, unknown>, signal: AbortSignal): Promise<DomainOperation>;
  lookup(key: string, signal: AbortSignal): Promise<DomainOperation | undefined>;
}
type PrivateData = { result: { domainSnapshot: DomainSnapshot }; configurationDigest: string; quantityUnit?: string };
function domainFacts(domain: ServiceDomain, snapshot: DomainSnapshot, quantityUnit?: string): CandidateFacts {
  const p = snapshot.parameters, r = snapshot.observation, actual = r ?? p;
  const defaultUnit = domain === 'food' ? '份' : domain === 'hotel' ? '间' : '人';
  const unit = quantityUnit ?? defaultUnit;
  const people = ['人', 'person', 'persons'].includes(unit), rooms = ['间', '间房', 'room', 'rooms'].includes(unit), meals = ['份', 'meal', 'meals'].includes(unit);
  let amount: unknown;
  if (people) amount = domain === 'appointment' ? 1 : domain === 'hotel' ? actual.guests : domain === 'itinerary' ? p.travelers : actual.passengers;
  if (rooms && domain === 'hotel') amount = actual.rooms;
  if (meals && domain === 'food') {
    const items = (r ? r.deliveredItems : p.items) as { quantity: number }[] | undefined;
    amount = items?.reduce((n, i) => n + i.quantity, 0);
  }
  const price = !r ? snapshot.option.total : domain === 'ride' ? r.finalFare : domain === 'appointment' ? r.fee : r.total;
  const deadline = !r ? snapshot.option.commitmentBy : domain === 'ride' ? r.arrivedAt : domain === 'appointment' ? r.confirmedAt : domain === 'food' ? r.deliveredAt : domain === 'hotel' ? p.endpoint === 'stay_completed' ? r.checkedOutAt : r.confirmedAt : domain === 'vehicle' ? p.endpoint === 'completed' ? r.returnedAt : r.confirmedAt : r.validatedAt;
  const location = domain === 'appointment' ? actual.hospitalId : domain === 'hotel' ? actual.hotelId : domain === 'vehicle' ? actual.returnLocation : domain === 'itinerary' ? ((actual.legs as { destination: string }[] | undefined)?.at(-1)?.destination) : actual.destination;
  const quantities: NonNullable<CandidateFacts['quantities']> = {}, amounts: NonNullable<CandidateFacts['amounts']> = {}, deadlines: NonNullable<CandidateFacts['deadlines']> = {}, locations: NonNullable<CandidateFacts['locations']> = {};
  const addCount = (role: keyof typeof quantities, value: unknown, unit: string) => { if (typeof value === 'number' && Number.isSafeInteger(value)) quantities[role] = { amount: String(value), unit }; };
  const addTime = (role: keyof typeof deadlines, value: unknown) => { if (typeof value === 'string') deadlines[role] = value; };
  const addPlace = (role: keyof typeof locations, value: unknown) => { if (typeof value === 'string') locations[role] = value; };
  if (price) amounts.service_total = price as NonNullable<CandidateFacts['totalPrice']>;
  addTime('completion', r ? deadline : snapshot.option.commitments?.completion);
  if (domain === 'ride') {
    addCount('passenger_count', actual.passengers, 'person'); addPlace('origin', actual.origin); addPlace('destination', actual.destination);
    addTime('pickup', r ? r.pickedUpAt : snapshot.option.commitments?.pickup); addTime('arrival', r ? r.arrivedAt : snapshot.option.commitments?.arrival);
  } else if (domain === 'appointment') { addCount('patient_count', 1, 'person'); addPlace('venue', actual.hospitalId); addTime('registration', r ? r.confirmedAt : snapshot.option.commitments?.registration); }
  else if (domain === 'food') { const items = (r ? r.deliveredItems : p.items) as { quantity: number }[] | undefined; addCount('item_quantity', items?.reduce((n, i) => n + i.quantity, 0), 'meal'); addPlace('destination', actual.destination); }
  else if (domain === 'hotel') { addCount('room_count', actual.rooms, 'room'); addCount('guest_count', actual.guests, 'person'); addPlace('venue', actual.hotelId); }
  else if (domain === 'itinerary') { addCount('traveler_count', p.travelers, 'person'); addPlace('destination', location); }
  else { addCount('passenger_count', actual.passengers, 'person'); addPlace('pickup', actual.pickup); addPlace('return', actual.returnLocation); const deposit = r ? r.deposit : snapshot.option.deposit; if (deposit) amounts.deposit = deposit as NonNullable<CandidateFacts['totalPrice']>; }
  return { quantities, amounts, deadlines, locations, ...(typeof amount === 'number' && Number.isSafeInteger(amount) ? { quantity: { amount: String(amount), unit } } : {}), ...(price ? { totalPrice: price as CandidateFacts['totalPrice'] } : {}), ...(typeof deadline === 'string' ? { deliveryBy: deadline } : {}), ...(typeof location === 'string' ? { locationRef: location } : {}) };
}
export function domainCapability(domain: ServiceDomain): ServiceCapability {
  const d = serviceDomain(domain);
  return { ref: { id: domainCapabilityId(domain), version: '2' }, ontologyRef: { id: `eigos.${domain}`, version: '2' }, name: `${d.name}沙箱验证`, description: `${d.name}仅合成来源验证。${d.endpoint}。真实接口未接通；不得选择用于真实下单、付款或预约。`, tags: [domain, 'sandbox'], inputSchema: z.toJSONSchema(d.parameters), ontology: { objects: [d.requestType, d.candidateType, d.resultType, ...new Set([...d.objects, ...d.resultObjects])], decisionAction: d.action, eligibilityFunction: d.eligibleFunction, outcomeFunction: d.outcomeFunction, noLiveProvider: true }, actions: [{ ref: { id: `domain.${domain}.submit`, version: '1' }, effect: d.effect }], predicates: [{ id: `domain.${domain}.complete`, description: d.endpoint }], outcomePredicates: [`domain.${domain}.complete`], requirementRoles: domainRequirementRoles[domain], verifierRef: { id: `domain.${domain}.independent`, version: '1' }, completion: 'domain', environment: 'sandbox' };
}
export function domainBinding(provider: DomainSandboxProvider): ProviderBinding {
  return { ref: { id: `domain.${provider.domain}.${provider.id}`, version: '2' }, capabilityRef: domainCapability(provider.domain).ref, providerId: provider.id, channelId: 'domain-sandbox', adapterId: `domain.${provider.domain}.${provider.id}`, configurationDigest: provider.configurationDigest, protocol: 'local', enabled: true, verification: { level: 'simulated', evidenceRefs: ['tests/service-domains.test.ts'] }, recovery: { idempotency: 'provider_key', lookup: true } };
}
export class DomainServiceAdapter implements ActionAdapter {
  readonly environment = 'sandbox' as const;
  readonly id: string;
  constructor(private provider: DomainSandboxProvider) {
    if (provider.environment !== 'sandbox' || !/^[a-f0-9]{64}$/.test(provider.configurationDigest) || !/^[A-Za-z0-9_-]{1,100}$/.test(provider.id)) throw new Error('An explicit versioned sandbox provider is required');
    this.id = domainBinding(provider).adapterId;
  }
  permitted(owner: string) { return owner === JSON.stringify(['local-development', 'local', 'developer']); }
  private assertScope(owner: string, environment: string | undefined) { if (!this.permitted(owner) || environment !== 'sandbox') throw new DomainError('FORBIDDEN', 'Domain fixtures cannot serve a real business request'); }
  async prepare(ctx: AdapterContext, input: unknown, signal: AbortSignal): Promise<Preparation> {
    this.assertScope(ctx.owner, ctx.request.executionEnvironment); signal.throwIfAborted();
    const parameters = parseDomainParameters(this.provider.domain, input), prepared = await this.provider.prepare(parameters, signal); signal.throwIfAborted();
    const option = domainOptionSchema.parse(prepared.option);
    if (option.providerId !== this.provider.id || option.parametersDigest !== digest(parameters) || digest(parseDomainParameters(this.provider.domain, option.offeredParameters)) !== digest(parameters)) throw new DomainError('CONFLICT', 'Domain source changed the requested parameters');
    const roleChecks = quoteRoleCriteria(this.provider.domain, parameters, option);
    if (roleChecks.some(c => c.result !== 'pass')) return { kind: 'unavailable', reason: '来源尚未证明各业务角色对应的时间或金额条件。', details: { roleChecks } };
    if (option.availability !== 'available' || option.eligibility !== 'verified' || !option.termsMatch || !option.feesComplete || option.total.currency !== parameters.budget.currency || BigInt(option.total.minor) > BigInt(parameters.budget.minor) || Date.parse(option.expiresAt) <= Date.now() || Date.parse(option.observedAt) > Date.now()) return { kind: 'unavailable', reason: '领域候选的资格、可用性、完整费用、条款或时效尚未通过核验。', details: { environment: 'sandbox', realSourceConnected: false } };
    const snapshot = domainSnapshotSchema.parse({ domain: this.provider.domain, environment: 'sandbox', requestId: ctx.request.id, requestRevision: ctx.request.revision, parameters, option, sourceId: this.provider.id, sourceEventId: option.id, sourceVersion: 1, entities: prepared.entities ?? [], relationships: prepared.relationships ?? [] });
    const d = serviceDomain(this.provider.domain);
    const quantityUnit = ctx.request.requirements.find(r => r.kind === 'quantity' && !r.role)?.expected as { unit?: string } | undefined;
    return { kind: 'ready', input: parameters, details: { domain: d.id, environment: 'sandbox', realSourceConnected: false, endpoint: d.endpoint }, facts: domainFacts(d.id, snapshot, quantityUnit?.unit), evidenceRefs: [`synthetic:domain:${digest(snapshot)}`], observedAt: option.observedAt, expiresAt: option.expiresAt, privateData: { result: { domainSnapshot: snapshot }, configurationDigest: this.provider.configurationDigest, quantityUnit: quantityUnit?.unit } satisfies PrivateData,
      recipe: [{ id: 'domain-service', operationId: `${d.id}-business-operation`, actionTypeRef: { id: `domain.${d.id}.submit`, version: '1' }, input: parameters, inputRefs: [], dependsOn: [], ...(d.effect === 'local' ? {} : { cost: { minor: '0', currency: option.total.currency, payeeId: this.provider.id } }) }] };
  }
  validateInput(step: PlanStep, input: Record<string, unknown>) {
    const d = serviceDomain(this.provider.domain);
    if (step.actionTypeRef.id !== `domain.${d.id}.submit` || step.actionTypeRef.version !== '1' || step.effect !== d.effect) throw new DomainError('FORBIDDEN', 'Domain operation does not match the registered effect');
    parseDomainParameters(d.id, input);
  }
  private payload(ctx: ActionContext, data: unknown): PrivateData {
    if (!this.permitted(ctx.owner)) throw new DomainError('FORBIDDEN', 'Sandbox identity is unavailable');
    const p = data as PrivateData, snapshot = domainSnapshotSchema.parse(p.result?.domainSnapshot);
    if (p.configurationDigest !== this.provider.configurationDigest || snapshot.domain !== this.provider.domain || snapshot.sourceId !== this.provider.id || snapshot.requestId !== ctx.requestId || snapshot.requestRevision !== ctx.requestRevision || digest(snapshot.parameters) !== digest(ctx.input)) throw new DomainError('CONFLICT', 'Domain action differs from its fixed source, request or input');
    return { ...p, result: { domainSnapshot: snapshot } };
  }
  async dispatch(ctx: ActionContext, data: unknown, signal: AbortSignal) {
    this.payload(ctx, data); signal.throwIfAborted();
    const result = await this.provider.submit(ctx.intent.businessOperationKey, ctx.input, signal); signal.throwIfAborted();
    return this.result(ctx, data, result);
  }
  async observe(ctx: ActionContext, data: unknown, signal: AbortSignal) { return this.reconcile(ctx, data, signal); }
  async reconcile(ctx: ActionContext, data: unknown, signal: AbortSignal): Promise<ActionResult> {
    this.payload(ctx, data); signal.throwIfAborted();
    const result = await this.provider.lookup(ctx.intent.businessOperationKey, signal); signal.throwIfAborted();
    if (!result) return { kind: 'not_found', eventId: `${ctx.intent.businessOperationKey}:not-found`, sourceVersion: 0, output: { operationKey: ctx.intent.businessOperationKey }, evidenceRefs: [`synthetic:lookup:${ctx.intent.businessOperationKey}`] };
    return this.result(ctx, data, result);
  }
  private result(ctx: ActionContext, data: unknown, raw: unknown): ActionResult {
    const p = this.payload(ctx, data), parsed = operationSchema.parse(raw);
    // Validate the full source schema before redaction so unsupported fields are
    // rejected instead of being silently discarded from an accepted readback.
    parseDomainResultResources(this.provider.domain, parsed.observation, parsed.entities, parsed.relationships);
    const operation = { ...parsed, ...(parsed.entities ? { entities: publicDomainEntities(parsed.entities) } : {}) };
    if (operation.key !== ctx.intent.businessOperationKey || operation.inputDigest !== ctx.attempt.inputDigest) throw new DomainError('CONFLICT', 'Domain source returned another operation or input');
    const observation = domainResultSchemas[this.provider.domain].parse(operation.observation), resources = { ...parseDomainResultResources(this.provider.domain, observation, operation.entities, operation.relationships), preparedEntities: p.result.domainSnapshot.entities }, assessment = assessDomain(this.provider.domain, ctx.input, observation, Date.now(), resources);
    const snapshot: DomainSnapshot = { ...p.result.domainSnapshot, entities: publicDomainEntities(p.result.domainSnapshot.entities), observation, sourceEventId: operation.eventId, sourceVersion: operation.version, preparedSource: { eventId: p.result.domainSnapshot.sourceEventId, version: p.result.domainSnapshot.sourceVersion }, ...(operation.entities ? { resultEntities: operation.entities } : {}), ...(operation.relationships ? { resultRelationships: operation.relationships } : {}) };
    const terminal = assessment.status !== 'unknown', evidenceRefs = [`synthetic:domain:${digest(snapshot)}`];
    const result: ActionResult = { kind: terminal ? 'confirmed' : 'pending', eventId: operation.eventId, sourceVersion: operation.version, remoteRef: observation.providerReference, output: { operation, domainSnapshot: snapshot }, business: { domain: { name: this.provider.domain, ...assessment } }, evidenceRefs, retryAfterMs: 100 };
    if (terminal) result.delivery = { artifact: { id: digest(snapshot), name: `${this.provider.domain}-sandbox-result.json`, data: { goal: ctx.goal, deliverable: `${serviceDomain(this.provider.domain).name}合成流程已核验；真实接口未接通，没有实际下单、付款或预约。`, execution: 'completed', result: { environment: 'sandbox', domainSnapshot: snapshot, assessment } } }, facts: { ...domainFacts(this.provider.domain, snapshot, p.quantityUnit), conditions: assessment.status === 'satisfied' ? [`domain.${this.provider.domain}.complete`] : [] }, evidenceRefs };
    return result;
  }
  verifyAction(ctx: ActionContext, result: ActionResult) {
    try {
      if (result.kind === 'not_found') return { accepted: result.output?.operationKey === ctx.intent.businessOperationKey, reason: 'Original-key lookup only; absence never authorizes replay' };
      const operation = operationSchema.parse(result.output?.operation), original = this.payload(ctx, ctx.intent.privateData).result.domainSnapshot, resources = { ...parseDomainResultResources(this.provider.domain, operation.observation, operation.entities, operation.relationships), preparedEntities: original.entities }, assessment = assessDomain(this.provider.domain, ctx.input, operation.observation, Date.now(), resources);
      const observation = domainResultSchemas[this.provider.domain].parse(operation.observation);
      const snapshot = domainSnapshotSchema.parse(result.output?.domainSnapshot);
      if (ctx.intent.remoteRef && ctx.intent.remoteRef !== observation.providerReference) throw new Error('The original business reference changed');
      if (digest(snapshot.option) !== digest(original.option) || digest(snapshot.entities) !== digest(publicDomainEntities(original.entities)) || digest(snapshot.relationships) !== digest(original.relationships)) throw new Error('The source snapshot differs from the prepared operation');
      if (digest(snapshot.preparedSource ?? null) !== digest({ eventId: original.sourceEventId, version: original.sourceVersion }) || digest(snapshot.resultEntities ?? []) !== digest(operation.entities ?? []) || digest(snapshot.resultRelationships ?? []) !== digest(operation.relationships ?? [])) throw new Error('The actual assignment readback is not bound to this operation and fixed preflight snapshot');
      const accepted = operation.key === ctx.intent.businessOperationKey && operation.inputDigest === ctx.attempt.inputDigest && result.eventId === operation.eventId && result.sourceVersion === operation.version && result.remoteRef === observation.providerReference && digest(result.business?.domain) === digest({ name: this.provider.domain, ...assessment }) && result.kind === (assessment.status === 'unknown' ? 'pending' : 'confirmed') && snapshot.requestId === ctx.requestId && snapshot.requestRevision === ctx.requestRevision && snapshot.domain === this.provider.domain && snapshot.sourceId === this.provider.id && snapshot.sourceEventId === operation.eventId && snapshot.sourceVersion === operation.version && digest(snapshot.observation) === digest(observation) && digest(snapshot.parameters) === digest(ctx.input);
      return { accepted, reason: 'Independently checked original operation, source version, input, domain state and outcome criteria' };
    } catch { return { accepted: false, reason: 'Domain operation or outcome does not match the fixed contract' }; }
  }
  verify(ctx: AdapterContext, plan: ExecutionPlan, data: unknown, delivery: Delivery) {
    try {
      this.assertScope(ctx.owner, ctx.request.executionEnvironment);
      const payload = data as PrivateData, report = delivery.artifact.data.result as { domainSnapshot?: unknown; assessment?: unknown };
      const s = domainSnapshotSchema.parse(report.domainSnapshot), original = domainSnapshotSchema.parse(payload.result.domainSnapshot), resources = { ...parseDomainResultResources(this.provider.domain, s.observation!, s.resultEntities, s.resultRelationships), preparedEntities: original.entities }, result = assessDomain(this.provider.domain, original.parameters, s.observation, Date.now(), resources);
      if (digest(s.preparedSource ?? null) !== digest({ eventId: original.sourceEventId, version: original.sourceVersion })) throw new Error('The delivered result lost its fixed candidate source identity');
      const accepted = payload.configurationDigest === this.provider.configurationDigest && s.requestId === ctx.request.id && s.requestRevision === ctx.request.revision && s.sourceId === this.provider.id && s.domain === this.provider.domain && digest(s.parameters) === digest(plan.steps[0]!.input) && digest(s.option) === digest(original.option) && digest(s.entities) === digest(publicDomainEntities(original.entities)) && digest(s.relationships) === digest(original.relationships) && result.status === 'satisfied' && digest(report.assessment) === digest(result) && delivery.artifact.id === digest(s) && delivery.evidenceRefs.includes(`synthetic:domain:${digest(s)}`);
      return { accepted, reason: accepted ? 'All fixed domain criteria independently verified against synthetic source evidence' : 'Domain outcome remains unproven or contradicts the fixed request' };
    } catch { return { accepted: false, reason: 'Domain delivery is malformed, stale or not owner-bound' }; }
  }
}
