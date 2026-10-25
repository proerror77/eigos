import { z } from 'zod';
import { digest } from './delegation.js';
import { DomainError } from './domain.js';
import type { AgentProgram } from './agent-program.js';
import type { OntologyObjectStore } from '../ontology/object-store.js';

/** A program binds registered Ontology Actions; it cannot redefine their effects
 * or schemas. Discoverability alone never grants permission to a connector. */
export function boundAgentAction(graph: OntologyObjectStore, program: AgentProgram, id: string) {
  const bindings = program.capability().actions.filter(a => a.ref.id === id);
  const definition = graph.model.action(id), operation = definition.read ?? definition.operation;
  if (bindings.length !== 1 || !operation || bindings[0]!.ref.version !== operation.version || bindings[0]!.effect !== operation.effect
    || digest(bindings[0]!.additionalEffects ?? []) !== digest('additionalEffects' in operation ? operation.additionalEffects ?? [] : [])
    || digest(definition) !== digest(program.definition(graph, id)) || digest(operation.inputSchema) !== digest(z.toJSONSchema(program.schema(id)))) {
    throw new DomainError('FORBIDDEN', 'Program binding differs from its registered Ontology Action');
  }
  return definition;
}
export function boundAgentActionIds(graph: OntologyObjectStore, program: AgentProgram) {
  const ids = program.capability().actions.map(a => a.ref.id);
  if (new Set(ids).size !== ids.length) throw new DomainError('CONFLICT', 'Duplicate program Action binding');
  for (const id of ids) boundAgentAction(graph, program, id);
  return ids;
}
