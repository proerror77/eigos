/** Opt-in contract audit for the existing synthetic scenario suites. This never
 * runs in application code and never replaces business results or permissions.
 * Usage: node --import tsx --import ./tests/fixtures/function-contract-audit.ts
 *   --test <existing scenario files>; set EIGOS_FUNCTION_AUDIT_REPORT_DIR to an
 * explicit temporary directory to collect per-process coverage summaries. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFunctionContractCloseoutDefinition, compiledSeedModel } from '../../packages/ontology/seed-definition.js';
import { OntologyObjectStore } from '../../packages/ontology/object-store.js';
import { functionCallSchema, evaluateLegacyFunctionProgram, type Computation } from '../../packages/ontology/object-functions.js';
import { constrainFunctionReads, resolveFunctionRuntime, validateFunctionComputation } from '../../packages/ontology/function-runtime.js';
import { runGraphProgram, type GraphProgram } from '../../packages/ontology/graph-program.js';

const seed = createFunctionContractCloseoutDefinition(), model = compiledSeedModel(seed, seed.registry);
const original = OntologyObjectStore.prototype.evaluate;
const known = new Set<string>(), unknown = new Set<string>(), errors = new Map<string, string>();
let auditing = false;
let lastRead: unknown;
const summary = () => ({ file: process.argv[1], known: [...known].sort(), unknown: [...unknown].sort(), errors: Object.fromEntries(errors) });
const save = () => { if (process.env.EIGOS_FUNCTION_AUDIT_REPORT_DIR) writeFileSync(join(process.env.EIGOS_FUNCTION_AUDIT_REPORT_DIR, `${process.pid}.json`), JSON.stringify(summary())); };
function* trace<T>(program: GraphProgram<T>): GraphProgram<T> {
  let next = program.next();
  try { while (!next.done) {
    let operation = next.value;
    if (operation.method === 'integrity' || operation.method === 'registeredFunction') operation = { ...operation, program: trace(operation.program) };
    if ('args' in operation) {
      const arg = operation.args[1] as unknown as { type?: string; object?: { type: string }; from?: { type: string }; link?: string; as?: string };
      lastRead = { method: operation.method, type: arg?.type ?? arg?.object?.type ?? arg?.from?.type, relationship: operation.method === 'related' ? operation.args[2] : arg?.link, as: arg?.as };
    }
    try { next = program.next(yield operation); } catch (error) { next = program.throw(error); }
  } return next.value; } finally { program.return(undefined as T); }
}
OntologyObjectStore.prototype.evaluate = function (owner, raw, budget) {
  const initialBudget = budget?.remaining ?? 1000;
  const result = original.call(this, owner, raw, budget);
  // Public projection and current security frames have their own tests. An
  // audit must never borrow/extend a finished inference authorization scope.
  if (auditing || this.security || !raw || typeof raw !== 'object' || !('function' in raw) || typeof raw.function !== 'string') return result;
  const binding = resolveFunctionRuntime(model, raw.function);
  if (!binding || binding.implementation.contract.version !== '2') return result;
  const { functionRef: _function, model: _model, ...computation } = result;
  try {
    validateFunctionComputation(binding, computation);
    if (computation.status === 'known') {
      const args = functionCallSchema.parse(raw); auditing = true;
      // The real fixture keeps its actual pinned model and facts. Apply the new
      // read contract to that exact handler, rather than fabricating responses
      // or relabelling an old task as a new release.
      const checked: Computation = runGraphProgram(this, constrainFunctionReads(trace(evaluateLegacyFunctionProgram(this, owner, args, { remaining: initialBudget })), binding.implementation.contract.mode === 'validated' ? binding.implementation.contract.reads : undefined, this.model, args.object));
      assert.equal(checked.status, 'known', `${raw.function} lost a known fixture under its declared reads: ${checked.reason ?? ''}`);
      assert.deepEqual(checked.value, computation.value, `${raw.function} changed its actual business value during read validation`);
      known.add(raw.function);
    } else unknown.add(raw.function);
  } catch (error) {
    const parsed = computation.status === 'known' ? binding.implementation.value?.safeParse(computation.value) : undefined;
    errors.set(raw.function, JSON.stringify({ message: error instanceof Error ? error.message : String(error), read: lastRead,
      ...(parsed && !parsed.success ? { issues: parsed.error.issues.slice(0, 10) } : {}) }));
    save();
    throw new Error(`Function contract audit failed: ${raw.function}`, { cause: error });
  } finally { auditing = false; }
  return result;
};
process.once('exit', () => {
  if (process.env.EIGOS_FUNCTION_AUDIT_REPORT_DIR) save();
  else if (known.size || unknown.size || errors.size) process.stdout.write(`\nFUNCTION_CONTRACT_AUDIT ${JSON.stringify(summary())}\n`);
});
