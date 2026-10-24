import { DomainError } from '../core/domain.js';
import { digest, type Grounding } from '../core/delegation.js';
import type { AgentProgram } from '../core/agent-program.js';
import type { Job } from '../core/domain.js';
import type { AgentDecision, AgentActionPlan } from '../ontology/agent-actions.js';
import type { OntologyObjectStore } from '../ontology/object-store.js';
import type { ObjectRef } from '../ontology/model.js';
import { contextDefinitionInput } from './planning-session.js';

const fail = (message: string): never => { throw new DomainError('CONFLICT', message); };
/** Eligibility comes from current definitions, never provider names or a recipe. */
export function initialActionIds(graph: OntologyObjectStore, program: AgentProgram): string[] {
  if (!program.actionIds.every(id => { const read = graph.model.action(id).read; return read?.effect === 'read' && read.mcp; })) return [];
  return program.actionIds.filter(id => {
    const definition = graph.model.action(id);
    return definition.read!.mcp!.requires.every(dependency => dependency.derive || dependency.evidence === 'accepted') && Object.keys(definition.inputs).length > 0;
  });
}

/** Only bind explicitly declared scope slots to an actually initialized scope.
 * All business arguments and action choices remain exactly the model's output. */
export function bindInitialSelection(graph: OntologyObjectStore, program: AgentProgram, scope: ObjectRef, grounding: Grounding): AgentDecision {
  if (grounding.kind !== 'resolve' || !grounding.initialSteps?.length || digest(grounding.capabilityRef) !== digest(program.ref)) fail('Initial selection requires an exact resolved program');
  const available = initialActionIds(graph, program);
  const steps = grounding.initialSteps!.map(step => {
    if (!available.includes(step.action)) fail('Initial actions require permitted read-only MCP actions with declared source bindings');
    const definition = graph.model.action(step.action), input: unknown = JSON.parse(step.argumentsJson);
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Initial arguments must be an object');
    const bound = { ...input as Record<string, unknown> };
    if (new Set(step.scopeInputs).size !== step.scopeInputs.length) fail('Duplicate initial scope binding');
    for (const key of step.scopeInputs) {
      if (Object.hasOwn(bound, key) || !Object.hasOwn(definition.inputs, key) || !graph.model.implements(scope.type, definition.inputs[key]!)) fail('Initial scope binding does not match the registered input');
      bound[key] = scope;
    }
    return { id: step.id, action: step.action, argumentsJson: JSON.stringify(bound), dependsOn: step.dependsOn ?? [], inputRefs: step.inputRefs ?? [] };
  });
  return { kind: 'execute', requestRevision: grounding.requestRevision, message: grounding.message, steps, completionJson: '', ...(grounding.plannedCompletion ? { plannedCompletion: grounding.plannedCompletion } : {}) };
}

export function recordedInitialSelection(job: Job, modelRunId: string): Grounding {
  const selected = job.delegation?.groundingDecisions?.find(item => item.modelRunId === modelRunId);
  const run = job.runs?.find(item => item.id === modelRunId);
  if (!selected || !run || run.purpose !== 'grounding' || run.decisionDigest !== digest(selected.decision)) return fail('Initial actions do not match the actual grounding model response');
  return selected.decision;
}

export function verifyInitialPlan(job: Job, graph: OntologyObjectStore, program: AgentProgram, plan: AgentActionPlan): void {
  const source = plan.initialSelection ?? fail('Missing initial selection provenance');
  if (plan.sequence !== 1 || source.modelRunId !== plan.modelRunId) fail('Invalid initial selection provenance');
  const grounding = recordedInitialSelection(job, source.modelRunId);
  const { digest: sourceDigest, ...sourceBody } = source.groundingPlanning;
  if (!grounding.initialSteps?.length || source.definitionActions.length > 8 || sourceDigest !== digest(sourceBody) || digest(sourceBody.model) !== digest(graph.model.ref) || grounding.initialSteps.some(step => !source.definitionActions.includes(step.action)) || !sourceBody.reads.some(read => read.tool === 'describe_ontology' && read.status === 'ok' && read.inputDigest === digest(contextDefinitionInput(graph, source.definitionActions)))) fail('Initial actions require their actual pre-model definitions');
  if (digest(plan.modelDecision) !== digest(bindInitialSelection(graph, program, plan.scope, grounding))) fail('Initial executable choice differs from its model-selected draft');
  const run = job.runs!.find(item => item.id === source.modelRunId)!;
  if (!run.ontologyContext || !run.ontologyContext.receiptIds.every(id => source.groundingPlanning.reads.some(read => read.id === id)) || source.groundingPlanning.reads.some(read => read.at > (run.requestSentAt ?? run.startedAt))) fail('Initial definitions and request must actually be read before the model');
  if (plan.ontologyPlanning.reads.some(read => read.at < run.completedAt || read.at > plan.createdAt)) fail('Actual scope binding must occur after the model and before dispatch');
  const combined = [...source.groundingPlanning.reads, ...plan.ontologyPlanning.reads];
  const ledger = new Map((job.delegation?.ontologyReads ?? []).map(read => [read.id, read]));
  if (new Set(combined.map(read => read.id)).size !== combined.length || combined.some(read => !ledger.has(read.id) || digest(read) !== digest(ledger.get(read.id)))) fail('Initial read evidence differs from the durable ontology ledger');
  if (combined.length > 20 || combined.some(read => read.outputBytes === undefined) || combined.reduce((n, read) => n + read.outputBytes!, 0) > 200000) fail('Combined grounding and initial binding read budget exceeded');
}
