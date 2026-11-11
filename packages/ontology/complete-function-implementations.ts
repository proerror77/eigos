import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { functionCallSchema, evaluateLegacyFunctionProgram } from './object-functions.js';
import type { FunctionDefinition, OntologyModel } from './model.js';
import { completeFunctionValueSchemas } from './complete-function-values.js';
import { completeFunctionReadSets } from './complete-function-reads.js';
import { functionInputNormalizes, type FunctionImplementation } from './function-runtime.js';
import type { FunctionExecutionContract } from './function-contracts.js';

const reviewed = new WeakMap<OntologyModel, { values: ReturnType<typeof completeFunctionValueSchemas>; reads: ReturnType<typeof completeFunctionReadSets> }>();
const implementations = new Map<string, FunctionImplementation>();
const key = (definition: Pick<FunctionDefinition, 'id' | 'version' | 'executionContract'>) => digest({ id: definition.id, version: definition.version, contract: definition.executionContract });

/** Called by the forward software release builder against its exact predecessor.
 * Reusing actual source parsers does not authorize a caller or install JSON code. */
export function registerCompleteFunctionImplementation(definition: Pick<FunctionDefinition, 'id' | 'version'>, model: OntologyModel): FunctionImplementation {
  let contracts = reviewed.get(model);
  if (!contracts) { contracts = { values: completeFunctionValueSchemas(model), reads: completeFunctionReadSets(model) }; reviewed.set(model, contracts); }
  const input = functionCallSchema.options.find(schema => schema.shape.function.value === definition.id), value = contracts.values.get(definition.id), reads = contracts.reads.get(definition.id);
  if (!input || !value || !reads) throw new DomainError('CONFLICT', `No complete reviewed function contract: ${definition.id}`);
  const contract: FunctionExecutionContract = { version: '2', mode: 'validated', inputSchema: z.toJSONSchema(input, { io: 'input' }), valueSchema: z.toJSONSchema(value), reads: structuredClone(reads), unknown: 'explicit_reason_no_value',
    ...(functionInputNormalizes(input) ? { parameterNormalization: 'registered_parser' as const } : {}) };
  const identity = key({ ...definition, executionContract: contract }), previous = implementations.get(identity);
  if (previous) return previous;
  const { id, version } = definition;
  const implementation: FunctionImplementation = { input, value, contract,
    execute(graph, owner, raw, budget) {
      if (graph.model.function(id).version !== version) throw new DomainError('CONFLICT', 'Function executor differs from the pinned semantic version');
      return evaluateLegacyFunctionProgram(graph, owner, input.parse(raw), budget);
    },
  };
  implementations.set(identity, implementation); return implementation;
}

/** Lookup only: a definition cannot manufacture a new executable registration. */
export function completeFunctionImplementation(definition: Pick<FunctionDefinition, 'id' | 'version' | 'executionContract'>): FunctionImplementation {
  const implementation = implementations.get(key(definition));
  if (!implementation) throw new DomainError('CONFLICT', 'The exact complete function implementation is not installed');
  return implementation;
}
