// An EIGOS Function in TypeScript: JSON input in, JSON output out. See README.md for building and publishing it.

/** The Function's input, as the `parameters` schema of its definition describes it. */
type Input = { values: number[] };
/** The Function's output, as the `returns` schema of its definition describes it. */
type Output = { sum: number; count: number };

function run(input: Input): Output {
  if (!Array.isArray(input.values) || input.values.length === 0) fail('empty', 'Give at least one value');
  return { sum: input.values.reduce((total, value) => total + value, 0), count: input.values.length };
}

/** Ends the call with a failure for the caller: a stable code it can act on, and a message for people. */
function fail(code: string, message: string): never {
  // ComponentizeJS returns a thrown value's `payload` as the world's `failure`; anything else thrown traps the call.
  throw Object.assign(new Error(message), { payload: { code, message } });
}

/** The export of the world `eigos:function/handler@0.1.0`. */
export function invoke(input: string): string {
  let parsed: Input;
  try {
    parsed = JSON.parse(input) as Input;
  } catch (error) {
    fail('invalid-input', String(error));
  }
  return JSON.stringify(run(parsed));
}
