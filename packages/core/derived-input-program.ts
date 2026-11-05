import type { AgentInputReference } from '../ontology/dataflow-contract.js';
import type { ObjectRef } from '../ontology/model.js';

/** A declared read-only calculation on an already accepted, exact object port.
 * This carries no source dispatch, business write or authority operation. */
export type DerivedInputProgram<T> = Generator<{ ref: AgentInputReference; object: ObjectRef }, T, unknown>;
export type DerivedInputResolver = (ref: AgentInputReference, object: ObjectRef) => unknown;
export function* derivedInput(ref: AgentInputReference, object: ObjectRef): DerivedInputProgram<unknown> { return yield { ref, object }; }
export function runDerivedInputs<T>(program: DerivedInputProgram<T>, resolve?: DerivedInputResolver): T {
  let step = program.next();
  while (!step.done) {
    let value: unknown;
    try {
      if (!resolve) throw new Error('No declared function resolver');
      value = resolve(step.value.ref, step.value.object);
      if (value && (typeof value === 'object' || typeof value === 'function') && 'then' in value && typeof value.then === 'function') throw new Error('Synchronous input binding cannot await a calculation');
    } catch (error) { step = program.throw(error); continue; }
    step = program.next(value);
  }
  return step.value;
}
export async function runDerivedInputsAsync<T>(program: DerivedInputProgram<T>, resolve?: DerivedInputResolver): Promise<T> {
  let step = program.next();
  while (!step.done) {
    let value: unknown;
    try { if (!resolve) throw new Error('No declared function resolver'); value = await resolve(step.value.ref, step.value.object); }
    catch (error) { step = program.throw(error); continue; }
    step = program.next(value);
  }
  return step.value;
}
