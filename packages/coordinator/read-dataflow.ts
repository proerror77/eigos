import { boundAgentAction, boundAgentActionIds } from '../core/agent-action-binding.js';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { AgentProgram } from '../core/agent-program.js';
import type { AgentDecision, AgentStep } from '../ontology/agent-actions.js';
import type { AgentInputReference } from '../ontology/dataflow-contract.js';
import type { ActionDefinition, ObjectRef } from '../ontology/model.js';
import { objectRefSchema } from '../ontology/model.js';
import type { OntologyObjectStore } from '../ontology/object-store.js';

const invalid = (message: string): never => { throw new DomainError('CONFLICT', message); };
export function dataflowArguments(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Dataflow arguments must be an object');
  return value as Record<string, unknown>;
}
export function dataflowValue(value: unknown, path: string[]): unknown {
  for (const key of path) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return invalid('Declared function output field is unavailable');
    value = (value as Record<string, unknown>)[key];
  }
  return structuredClone(value);
}

/** Check the selected graph; never add a source action, choose a value or run it. */
export function validateReadBindings(graph: OntologyObjectStore, program: AgentProgram, step: AgentStep,
  definition: ActionDefinition, input: Record<string, unknown>, preceding: Map<string, AgentStep>) {
  const targets = new Set<string>(), schema = program.schema(step.action);
  if (!step.inputRefs.length) { schema.parse(input); return; }
  if (!definition.read) invalid('Deferred bindings require a read action');
  const objectSchema = schema instanceof z.ZodObject ? schema : invalid('Deferred bindings require an object-shaped read action');
  const omitted: Record<string, true> = {};
  for (const ref of step.inputRefs) {
    const source = preceding.get(ref.stepId);
    if (!source || !step.dependsOn.includes(ref.stepId) || Object.hasOwn(input, ref.targetKey) || targets.has(ref.targetKey) || !Object.hasOwn(objectSchema.shape, ref.targetKey)) invalid('Invalid or ambiguous action output reference');
    targets.add(ref.targetKey); omitted[ref.targetKey] = true;
    const sourceType = boundAgentAction(graph, program, source!.action).read?.resultType;
    if (!sourceType) invalid('Deferred input must come from an explicitly selected read');
    if (ref.compute) {
      const dependency = definition.read!.mcp?.requires.find(dep => dep.selectionInput === ref.targetKey);
      const objectBinding = dependency && step.inputRefs.find(item => item.targetKey === dependency.observationInput && !item.compute);
      if (!dependency?.derive || dependency.objectType !== sourceType || digest(dependency.derive) !== digest(ref.compute) || objectBinding?.stepId !== ref.stepId) invalid('Function input binding is not declared by the action dependency');
      const fn = graph.model.function(ref.compute.function);
      if (!fn.inputTypes.some(type => graph.model.implements(sourceType!, type))) invalid('Function cannot consume the selected source type');
    } else {
      // Validate type compatibility without inventing a future object identity.
      const field = objectSchema.shape[ref.targetKey] as z.ZodType;
      const json = z.toJSONSchema(field) as { type?: string; properties?: { type?: { const?: string }; id?: unknown } };
      if (json.type !== 'object' || !json.properties?.type || !json.properties.id) invalid('Plain deferred inputs must accept an object reference');
      if (json.properties?.type?.const && !graph.model.implements(sourceType!, json.properties.type.const)) invalid('Deferred source type differs from the input type');
    }
  }
  objectSchema.omit(omitted).parse(input);
}

export function validatePlannedCompletion(graph: OntologyObjectStore, program: AgentProgram, decision: AgentDecision) {
  const completion = decision.plannedCompletion;
  if (!completion) return;
  if (decision.kind !== 'execute' || !decision.steps.length || decision.steps.some(step => !boundAgentAction(graph, program, step.action).read)) invalid('Planned completion is limited to selected read graphs');
  const input = dataflowArguments(completion.argumentsJson), targets = new Set<string>();
  const properties = (program.completionSchema as { properties?: Record<string, unknown> }).properties ?? {};
  for (const ref of completion.inputRefs) {
    const step = decision.steps.find(step => step.id === ref.stepId);
    if (!step || ref.compute || Object.hasOwn(input, ref.targetKey) || targets.has(ref.targetKey) || !Object.hasOwn(properties, ref.targetKey)
      || boundAgentAction(graph, program, step.action).read?.module?.completion.planned !== true) invalid('Completion needs an explicitly permitted accepted-output binding');
    targets.add(ref.targetKey);
  }
}

export function bindAcceptedObjects(input: Record<string, unknown>, refs: AgentInputReference[],
  source: (stepId: string) => unknown, compute?: (ref: AgentInputReference, object: ObjectRef) => unknown) {
  const bound = structuredClone(input);
  for (const ref of refs) {
    const object = objectRefSchema.parse(source(ref.stepId));
    bound[ref.targetKey] = ref.compute ? compute ? compute(ref, object) : invalid('No declared function resolver') : object;
  }
  return bound;
}
