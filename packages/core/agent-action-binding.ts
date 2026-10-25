import { z } from 'zod';
import { agentOperation } from './agent-authorization.js';
import type { JsonSchema } from '../ontology/definition-contracts.js';
import { compositionCompiler } from '../ontology/composition-contract.js';
import { digest } from './delegation.js';
import { DomainError } from './domain.js';
import type { AgentProgram } from './agent-program.js';
import type { OntologyObjectStore } from '../ontology/object-store.js';

/** A program binds registered Ontology Actions; it cannot redefine their effects
 * or schemas. Discoverability alone never grants permission to a connector. */
export function boundAgentAction(graph: OntologyObjectStore, program: AgentProgram, id: string) {
  const bindings = program.capability().actions.filter(a => a.ref.id === id);
  const definition = graph.model.action(id), operation = agentOperation(definition), declarative = definition.implementation?.kind === 'declarative';
  if (declarative && (!program.callerManagedActions || digest(definition.effects) !== digest(['object_write']))) throw new DomainError('FORBIDDEN', 'Declarative bindings require the trusted managed-data program and exact object_write effect');
  const schema = declarative ? z.toJSONSchema(compositionCompiler(graph.model).schema(operation.inputSchema as JsonSchema)) : operation.inputSchema;
  if (bindings.length !== 1 || bindings[0]!.ref.version !== (declarative ? definition.version : operation.version) || bindings[0]!.effect !== operation.effect
    || digest(bindings[0]!.additionalEffects ?? []) !== digest('additionalEffects' in operation ? operation.additionalEffects ?? [] : [])
    || digest(definition) !== digest(program.definition(graph, id)) || digest(schema) !== digest(z.toJSONSchema(program.schema(id)))) {
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
