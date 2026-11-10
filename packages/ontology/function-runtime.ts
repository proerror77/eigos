import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { nameSchema, objectRefSchema, type FunctionDefinition, type OntologyModel } from './model.js';
import type { HandlerRef } from './definition-contracts.js';
import type { FunctionExecutionContract, FunctionReadSet } from './function-contracts.js';
import type { Computation } from './object-functions.js';
import type { GraphProgram, ProjectionMetadata } from './graph-program.js';
import type { ReadBudget } from './object-store.js';

export interface FunctionImplementation {
  contract: FunctionExecutionContract;
  input: z.ZodType;
  value?: z.ZodType;
  execute(graph: ProjectionMetadata, owner: string, input: unknown, budget: ReadBudget): GraphProgram<Computation>;
}
export interface FunctionRuntimeBinding { handlerRef: HandlerRef; definitionDigest: string; implementation: FunctionImplementation }
const runtimes = new WeakMap<OntologyModel, { bindings: ReadonlyMap<string, FunctionRuntimeBinding>; identity: object }>();
const fail = (message: string): never => { throw new DomainError('CONFLICT', message); };
function freezeJson<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeJson(child); Object.freeze(value); }
  return value;
}

/** Called only by the trusted compiler. Definition JSON can select a reviewed
 * reference but cannot supply code, replace this map or make a function runnable. */
export function bindFunctionRuntimes(model: OntologyModel, bindings: ReadonlyMap<string, FunctionRuntimeBinding>): void {
  if (runtimes.has(model)) fail('Function runtime is already bound');
  const installed = new Map<string, FunctionRuntimeBinding>();
  for (const [id, binding] of bindings) {
    if (binding.definitionDigest !== digest(model.function(id))) fail('Function runtime differs from the pinned definition');
    installed.set(id, Object.freeze({ ...binding, handlerRef: Object.freeze({ ...binding.handlerRef }),
      implementation: Object.freeze({ ...binding.implementation, contract: freezeJson(structuredClone(binding.implementation.contract)) }) }));
  }
  runtimes.set(model, { bindings: installed, identity: Object.freeze({}) });
}
/** Opaque once-only identity; never exposes the writable map or registrations. */
export function functionRuntimeIdentity(model: OntologyModel): object | undefined { return runtimes.get(model)?.identity; }
export function resolveFunctionRuntime(model: OntologyModel, id: string): FunctionRuntimeBinding | undefined {
  // The compiler freezes definitions and verifies these pins once. Reusing an
  // implementation must not hash its entire schema on every authorized read.
  return runtimes.get(model)?.bindings.get(id);
}
const invocation = z.object({ function: nameSchema, object: objectRefSchema }).catchall(z.unknown());
export function parseFunctionInvocation(model: OntologyModel, raw: unknown): z.infer<typeof invocation> {
  const header = invocation.parse(raw), binding = resolveFunctionRuntime(model, header.function);
  if (!binding) {
    const definition = model.function(header.function);
    if (definition.executionContract) fail('The exact function executor is unavailable');
    return header; // Historical input validation remains inside the legacy dispatcher.
  }
  const parsed = binding.implementation.input.parse(raw);
  const canonical = invocation.parse(parsed);
  if (canonical.function !== header.function || digest(canonical.object) !== digest(header.object)) fail('Function parser cannot change the function or object identity');
  if (!binding.implementation.contract.parameterNormalization && digest(parsed) !== digest(raw)) fail('Function invocation cannot silently normalize input');
  return canonical;
}
/** Zod defaults, overwrites and transforms need an explicit normalization
 * declaration. Walk parser definitions, not arbitrary function source code. */
export function functionInputNormalizes(schema: z.ZodType): boolean {
  const seen = new Set<object>();
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    const definition = (value as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
    if (definition && (['default', 'prefault', 'catch', 'pipe', 'transform'].includes(String(definition.type)) || definition.check === 'overwrite')) return true;
    return Object.values(definition ?? value).some(visit);
  };
  return visit(schema);
}
export function assertFunctionImplementation(definition: FunctionDefinition, implementation: FunctionImplementation): void {
  const contract = implementation.contract;
  if (digest(contract.inputSchema) !== digest(z.toJSONSchema(implementation.input, { io: 'input' }))) fail('Function invocation schema differs from its executable parser');
  if (functionInputNormalizes(implementation.input) && !contract.parameterNormalization) fail('Normalizing function parsers require an explicit parameter normalization contract');
  const properties = contract.inputSchema.properties as Record<string, Record<string, unknown>> | undefined;
  if (contract.inputSchema.type !== 'object' || properties?.function?.const !== definition.id
    || !Array.isArray(contract.inputSchema.required) || !['function', 'object'].every(name => (contract.inputSchema.required as unknown[]).includes(name))) fail('Function parser must bind its declared name and object argument');
  if (contract.mode === 'validated' && (!implementation.value || digest(contract.valueSchema) !== digest(z.toJSONSchema(implementation.value)))) fail('Function result schema differs from its executable parser');
  if (definition.executionContract?.mode === 'validated' && contract.mode === 'validated' && typeof contract.valueSchema.type === 'string' && definition.returns) {
    const valueType = contract.valueSchema.type === 'string' && contract.valueSchema.format === 'date-time' ? 'timestamp' : contract.valueSchema.type;
    if (definition.returns.length !== 1 || definition.returns[0] !== valueType) fail('Function return label contradicts its validated value schema');
  }
  if (definition.executionContract && digest(definition.executionContract) !== digest(contract)) fail('Function execution contract differs from its registered implementation');
}

const evidence = { evidenceRefs: z.array(objectRefSchema), evidenceLevels: z.array(z.string()) };
const unknownResult = z.strictObject({ status: z.literal('unknown'), value: z.undefined().optional(), reason: z.string().min(1), ...evidence });
/** Validate without normalizing values: parsers cannot silently alter evidence or
 * business outputs. Unknown is an envelope state, never a false/zero substitute. */
export function validateFunctionComputation(binding: FunctionRuntimeBinding, computation: Computation): Computation {
  const schema = computation.status === 'unknown' ? unknownResult : z.strictObject({ status: z.literal('known'), value: binding.implementation.value ?? z.unknown(), reason: z.string().optional(), ...evidence });
  const parsed = schema.safeParse(computation);
  if (!parsed.success || computation.status === 'known' && !Object.hasOwn(computation, 'value') || parsed.success && digest(parsed.data) !== digest(computation)) fail('Function result violates its registered computation contract');
  return computation;
}

/** Declared reads bound code, not permission. Every yielded operation still goes
 * through the existing owner/task/field authorization and evidence envelope. */
export function* constrainFunctionReads<T>(program: GraphProgram<T>, reads?: FunctionReadSet, model?: OntologyModel): GraphProgram<T> {
  let state = program.next();
  try { while (!state.done) {
    let operation = state.value;
    const type = (ref: { type: string }) => { if (reads && !reads.types.some(target => ref.type === target || model?.implements(ref.type, target))) fail('Function read exceeds its declared object types'); };
    if (!reads) {
      if (operation.method === 'integrity' || operation.method === 'registeredFunction') operation = { ...operation, program: constrainFunctionReads(operation.program) };
      else if (!['read', 'readPrivate', 'related', 'query', 'relationshipDigest', 'evidencePropertiesDigest', 'containsLinks', 'semanticCandidates', 'revision', 'evaluate', 'virtualMembership'].includes(operation.method)) fail('Function attempted an undeclared graph operation');
      try { state = program.next(yield operation); } catch (error) { state = program.throw(error); }
      continue;
    }
    if (operation.method === 'integrity') {
      if (!reads.sourceProof) fail('Function has no declared source-proof read');
      operation = { ...operation, program: constrainFunctionReads(operation.program, reads, model) };
    }
    else if (operation.method === 'read' || operation.method === 'readPrivate' || operation.method === 'relationshipDigest' || operation.method === 'evidencePropertiesDigest') {
      type(operation.args[1]);
      if (['readPrivate', 'evidencePropertiesDigest'].includes(operation.method) && !reads.sourceProof) fail('Function has no declared source-proof read');
    }
    else if (operation.method === 'related') {
      const [, from, name] = operation.args; type(from);
      const declared = reads.relationships.some(link => {
        if (!model) return link.type === from.type && link.name === name;
        if (!model.implements(from.type, link.type)) return false;
        return model.navigation(from.type, link.name, model.isInterface(link.type) ? link.type : undefined).side.name === name;
      });
      if (!declared) fail('Function read exceeds its declared relationships');
    } else fail('Function attempted an undeclared graph operation');
    try {
      const result = yield operation;
      if (operation.method === 'related' && result !== undefined) {
        if (!Array.isArray(result)) fail('Function relationship returned an invalid collection');
        const [, from, name] = operation.args, target = model?.navigation(from.type, name).other.type;
        for (const object of result as unknown[]) {
          const parsed = objectRefSchema.safeParse(object && typeof object === 'object' ? (object as { ref?: unknown }).ref : undefined);
          if (!parsed.success) fail('Function relationship returned an invalid object reference');
          type(parsed.data!);
          if (target && !model!.implements(parsed.data!.type, target)) fail('Function relationship returned the wrong target type');
        }
      }
      state = program.next(result);
    } catch (error) { state = program.throw(error); }
  }
  return state.value;
  } finally { program.return(undefined as T); }
}
