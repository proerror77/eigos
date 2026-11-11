import { DomainError } from '../core/domain.js';
import type { OntologyDocument, JsonSchema } from './definition-contracts.js';
import { compileOntologyDocument, type TrustedDefinitionRegistry } from './model-compiler.js';
import { registerCompleteFunctionImplementation } from './complete-function-implementations.js';

function returnTypes(schema: JsonSchema): string[] {
  if (schema.type === 'string' && schema.format === 'date-time') return ['timestamp'];
  if (typeof schema.type === 'string') return [schema.type];
  if (Array.isArray(schema.anyOf)) return [...new Set((schema.anyOf as JsonSchema[]).flatMap(returnTypes))];
  throw new DomainError('CONFLICT', 'A reviewed result must declare its value type');
}

/** The semantic function versions stay pinned. v35 changes their invocation
 * contracts, never rewrites the already-published v34 document or handler refs. */
export function extendFunctionContractCloseoutKernel(original: OntologyDocument, registry: TrustedDefinitionRegistry): OntologyDocument {
  if (original.version !== '34') throw new DomainError('CONFLICT', 'Function closure requires the reviewed v34 predecessor');
  const model = compileOntologyDocument(original, registry), document = structuredClone(original);
  document.version = '35';
  let closed = 0;
  document.functions = document.functions.map(fn => {
    if (fn.executionContract?.mode === 'validated') return fn;
    const { handlerRef: _handler, executionContract: _execution, returns: _returns, ...semantic } = fn;
    const implementation = registerCompleteFunctionImplementation(semantic, model);
    if (implementation.contract.mode !== 'validated') throw new DomainError('CONFLICT', 'A closure function cannot remain unvalidated');
    const contract = { ...semantic, executionContract: implementation.contract, returns: returnTypes(implementation.contract.valueSchema) };
    closed++;
    return { ...contract, handlerRef: registry.registerFunction(contract, implementation) };
  });
  if (closed !== 52 || document.functions.some(fn => fn.executionContract?.mode !== 'validated')) throw new DomainError('CONFLICT', 'The complete reviewed legacy function set changed');
  return document;
}
