import type { OntologyObjectStore } from '../ontology/object-store.js';
import type { ObjectRef } from '../ontology/model.js';
import type { ResolvedCandidate, ServiceRequest } from '../ontology/execution.js';
import type { PlanningReadReceipt, PlanningSnapshot } from '../ontology/planning-contract.js';
import { runGraphProgram, type GraphProgram, type PlanningGraphStorage } from '../ontology/graph-program.js';
import { authorizationScope } from '../security/context.js';
import { accessDigest, secureRequest, assertModelChannel } from '../security/model.js';
import { authorizedDefinitions, describeAuthorized } from '../security/view.js';
import { PlanningSessionState, snapshotObjectProgram, validatePlanningSnapshotProgram, modelSessionKey as contextKey,
  type PlanningMetadata, type PlanningSessionOptions } from './planning-program.js';
export { contextDefinitionInput, planningQuerySchema, planningToolSchemas, planningToolCatalog, type PlanningSessionOptions } from './planning-program.js';

function metadata(graph: OntologyObjectStore): PlanningMetadata {
  const policy = graph.security;
  return { model: graph.model, now: graph.now, releaseRef: graph.releaseRef, security: !!policy,
    ...(policy ? { authorization: {
      accessDigest,
      definitions: () => authorizedDefinitions(policy.security, authorizationScope()!, graph.model),
      describe: input => describeAuthorized(policy.security, authorizationScope()!, input, graph.model),
      binding: ref => !!policy.binding(authorizationScope()!, ref),
      requireResource: (kind, id) => { policy.requireResource(authorizationScope()!, kind, id); },
      receipt: () => ({ accessDigest: accessDigest(), ...(authorizationScope()!.lineage.size ? { securityEnvelope: policy.outputEnvelope(authorizationScope()!.actor.ownerKey) } : {}) }),
    } } : {}),
  };
}
export const modelSessionKey = (owner: string, request: ServiceRequest, model: OntologyObjectStore['model']['ref']) => contextKey(owner, request, model, accessDigest());
export function snapshotObject(graph: OntologyObjectStore, owner: string, ref: ObjectRef, request: ServiceRequest) {
  return runGraphProgram(graph, snapshotObjectProgram(metadata(graph), owner, ref, request));
}
export function validatePlanningSnapshot(graph: OntologyObjectStore, owner: string, request: ServiceRequest, snapshot: PlanningSnapshot, fresh: boolean): void {
  const check = () => {
    const scoped = graph.forRequestReader(owner, request.id);
    return scoped.withReadMemo(owner, () => runGraphProgram(scoped, validatePlanningSnapshotProgram(metadata(scoped), owner, request, snapshot, fresh)));
  };
  return graph.security ? graph.security.readSnapshot(check) : check();
}

/** Synchronous storage adapter for the same request-scoped planning program. */
export class OntologyPlanningSession {
  private readonly state: PlanningSessionState;
  private readonly planning: PlanningGraphStorage;
  constructor(readonly graph: OntologyObjectStore, private owner: string, readonly request: ServiceRequest,
    private candidates: ResolvedCandidate[] = [], private active: () => void = () => {}, private onRead: (receipt: PlanningReadReceipt) => void = () => {},
    private readScope: 'owner' | 'request' = 'owner', private boundRefs: ObjectRef[] = [], private options: PlanningSessionOptions = {}) {
    this.graph = graph.forRequestReader(owner, request.id);
    if (graph.security) this.boundRefs = [...new Map([...boundRefs, ...(authorizationScope()?.grant?.inputs.map(input => input.object) ?? [])].map(ref => [JSON.stringify(ref), ref])).values()];
    this.state = new PlanningSessionState({ ...metadata(this.graph),
      runReadWindow: (value, program) => this.graph.withReadMemo(value, () => runGraphProgram(this.graph, program, this.planning)),
    }, owner, request, candidates, active, readScope, this.boundRefs, options);
    this.planning = { call: (...args) => this.call(...args), revision: value => this.graph.revision(value), evaluate: (...args) => this.graph.evaluate(...args),
      virtualMembership: (...args) => this.graph.virtualMembership(...args), pipelineChanges: (...args) => this.graph.pipelineChanges(...args),
      recordRead: onRead, discoverActions: (value, current, query) => {
        if (!options.actionCatalog) throw new Error('Action catalog is unavailable');
        return options.actionCatalog.discoverActions(this.graph, value, current, query);
      } };
  }
  private snapshot<T>(action: () => T): T { return this.graph.security && !authorizationScope()?.synchronousRead ? this.graph.security.readSnapshot(action) : action(); }
  private run<T>(program: GraphProgram<T>): T { return this.snapshot(() => runGraphProgram(this.graph, program, this.planning)); }
  hostEvidenceSession() {
    return new OntologyPlanningSession(this.graph, this.owner, this.request, this.candidates, this.active, this.onRead, this.readScope, this.boundRefs,
      { ...this.options, taskContext: undefined, priorReads: undefined });
  }
  usesTaskContext() { return this.state.usesTaskContext(); }
  requiresFinalResponse() { return this.state.requiresFinalResponse(); }
  readBudget() { return this.state.readBudget(); }
  catalog() { return this.snapshot(() => this.state.catalog()); }
  receipts() { return this.state.receipts(); }
  lastReceipt() { return this.state.lastReceipt(); }
  retrievedRefs() { return this.state.retrievedRefs(); }
  authorizeModel(channel?: string) {
    if (!this.graph.security) return;
    this.active(); this.snapshot(() => { secureRequest(this.graph, this.owner, this.request); assertModelChannel(this.graph, channel); });
  }
  acceptReceipts(ids: string[]): void { return this.run(this.state.acceptReceiptsProgram(ids)); }
  modelSessionKey() { return modelSessionKey(this.owner, this.request, this.graph.model.ref); }
  prepareContext(options: { actions?: string[]; refs?: ObjectRef[]; includeDefinitions?: boolean; includeLinkedFacts?: boolean } = {}) { return runGraphProgram(this.graph, this.state.prepareContextProgram(options), this.planning); }
  call(tool: string, input: unknown, options?: { origin: 'worker_context'; maxOutputBytes: number }): unknown { return this.run(this.state.callProgram(tool, input, options)); }
  finish(candidate?: ResolvedCandidate): PlanningSnapshot { return this.run(this.state.finishProgram(candidate)); }
}
