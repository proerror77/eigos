import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { nameSchema, objectRefSchema, type FunctionDefinition, type OntologyModel, type ObjectRef } from './model.js';
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
const sourceContextSchema = z.strictObject({ query: objectRefSchema, collection: nameSchema, observation: objectRefSchema });
interface FunctionReadScope { root?: ObjectRef; context?: z.infer<typeof sourceContextSchema>; observations: Set<string> }
const refKey = (ref: ObjectRef) => JSON.stringify([ref.type, ref.id]);
export function* constrainFunctionReads<T>(program: GraphProgram<T>, reads?: FunctionReadSet, model?: OntologyModel, root?: ObjectRef, scope: FunctionReadScope = { root: root && structuredClone(root), observations: new Set() }): GraphProgram<T> {
  let state = program.next();
  try { while (!state.done) {
    let operation = state.value;
    const type = (ref: ObjectRef) => { if (reads && !reads.types.some(target => ref.type === target || model?.implements(ref.type, target)) && !scope.observations.has(refKey(ref))) fail('Function read exceeds its declared object types'); };
    const dynamicCollection = (from: ObjectRef, name: string) => !!reads?.sourceContext && !!scope.context && refKey(from) === refKey(scope.context.query) && name === scope.context.collection;
    const relationship = (from: ObjectRef, name: string, as?: string) => {
      if (dynamicCollection(from, name)) return;
      type(from);
      if (reads?.sourceContext && scope.observations.has(refKey(from)) && name === 'sourceReceipts' && model?.navigation(from.type, name).other.type === 'SourceReceipt') return;
      const actualName = model?.navigation(from.type, name, as).side.name ?? name;
      const declared = reads!.relationships.some(link => {
        if (!model) return link.type === from.type && link.name === actualName;
        if (!model.implements(from.type, link.type)) return false;
        try { return model.navigation(from.type, link.name, model.isInterface(link.type) ? link.type : undefined).side.name === actualName; }
        catch { return false; }
      });
      if (!declared) fail('Function read exceeds its declared relationships');
    };
    if (!reads) {
      if (operation.method === 'integrity' || operation.method === 'registeredFunction') operation = { ...operation, program: constrainFunctionReads(operation.program) };
      else if (!['read', 'readPrivate', 'related', 'query', 'relationshipDigest', 'evidencePropertiesDigest', 'containsLinks', 'semanticCandidates', 'revision', 'evaluate', 'virtualMembership'].includes(operation.method)) fail('Function attempted an undeclared graph operation');
      try { state = program.next(yield operation); } catch (error) { state = program.throw(error); }
      continue;
    }
    if (operation.method === 'integrity') {
      if (!reads.sourceProof) fail('Function has no declared source-proof read');
      operation = { ...operation, program: constrainFunctionReads(operation.program, reads, model, root, scope) };
    }
    else if (operation.method === 'read' || operation.method === 'readPrivate' || operation.method === 'relationshipDigest' || operation.method === 'evidencePropertiesDigest') {
      type(operation.args[1]);
      if (['readPrivate', 'evidencePropertiesDigest'].includes(operation.method) && !reads.sourceProof) fail('Function has no declared source-proof read');
    }
    else if (operation.method === 'related') {
      const [, from, name] = operation.args; relationship(from, name);
    } else if (operation.method === 'query') {
      const query = operation.args[1];
      if ('object' in query) {
        type(query.object);
        if (!query.as || !reads.objectViews?.includes(query.as) || !model?.implements(query.object.type, query.as)) fail('Function object query exceeds its declared views');
      } else if ('from' in query) {
        if (!query.as || !reads.relationshipViews?.includes(query.as) || !model?.implements(query.from.type, query.as)) fail('Function relationship query exceeds its declared views');
        relationship(query.from, query.link, query.as);
      } else fail('Functions cannot enumerate undeclared type-wide queries');
    } else if (operation.method === 'containsLinks') {
      for (const link of operation.args[1]) {
        if (!reads.linkProofs?.includes(link.type)) fail('Function link proof exceeds its declared relationships');
        type(link.from); type(link.to);
        const definition = model?.link(link.type);
        if (!definition || !model!.implements(link.from.type, definition.from.type) || !model!.implements(link.to.type, definition.to.type)) fail('Function link proof has incompatible endpoints');
      }
    } else fail('Function attempted an undeclared graph operation');
    try {
      const result = yield operation;
      if (reads.sourceContext && operation.method === 'readPrivate' && scope.root && refKey(operation.args[1]) === refKey(scope.root)) {
        const rawContext = (result as { source?: { readContext?: unknown } } | undefined)?.source?.readContext;
        if (rawContext !== undefined) {
          const context = sourceContextSchema.parse(rawContext), navigation = model?.navigation(context.query.type, context.collection);
          if (!navigation || !model!.implements(context.observation.type, navigation.other.type)) fail('Source read context does not match its declared collection');
          if (scope.context && digest(context) !== digest(scope.context)) fail('Function source read context changed');
          scope.context = context; scope.observations.add(refKey(context.observation));
        }
      }
      if ((operation.method === 'related' || operation.method === 'query') && result !== undefined) {
        const query = operation.method === 'query' ? operation.args[1] : undefined;
        const point = query && 'object' in query ? query.object : undefined;
        const from = operation.method === 'related' ? operation.args[1] : query && 'from' in query ? query.from : undefined;
        const name = operation.method === 'related' ? operation.args[2] : query && 'from' in query ? query.link : undefined;
        const as = query && 'from' in query ? query.as : undefined;
        const target = from && name ? model?.navigation(from.type, name, as).other.type : undefined;
        const objects = operation.method === 'related' ? result : (result as { items?: unknown }).items;
        if (!Array.isArray(objects)) fail('Function read returned an invalid collection');
        for (const object of objects as unknown[]) {
          const parsed = objectRefSchema.safeParse(object && typeof object === 'object' ? (object as { ref?: unknown }).ref : undefined);
          if (!parsed.success) fail('Function relationship returned an invalid object reference');
          if (point && refKey(parsed.data!) !== refKey(point)) fail('Function point query returned another object');
          if (from && name && dynamicCollection(from, name)) {
            if (target && !model!.implements(parsed.data!.type, target)) fail('Function relationship returned the wrong target type');
            if (!scope.observations.has(refKey(parsed.data!)) && scope.observations.size >= 5000) fail('Function source read context exceeds its reference bound');
            scope.observations.add(refKey(parsed.data!));
          }
          type(parsed.data!);
          if (target && !model!.implements(parsed.data!.type, target)) fail('Function relationship returned the wrong target type');
        }
      } else if (operation.method === 'containsLinks' && typeof result !== 'boolean') {
        fail('Function link proof returned an invalid result');
      }
      state = program.next(result);
    } catch (error) { state = program.throw(error); }
  }
  return state.value;
  } finally { program.return(undefined as T); }
}
