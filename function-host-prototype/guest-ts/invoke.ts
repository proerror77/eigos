// PROTOTYPE guest: a TypeScript function in the EIGOS world. Throwing becomes the `err` of the result.
type Request = { spin?: number; allocate?: number; fail?: boolean; values?: number[] };

export function invoke(input: string): string {
  const request = JSON.parse(input) as Request;
  if (request.spin) {
    let x = 0;
    for (let i = 0; i < request.spin; i++) x += i % 7;
    return JSON.stringify({ x });
  }
  if (request.allocate) {
    const chunks: number[][] = [];
    for (let i = 0; i < request.allocate; i++) chunks.push(new Array(1 << 17).fill(i));
    return JSON.stringify({ chunks: chunks.length });
  }
  // ComponentizeJS takes the `err` case from the thrown value's `payload`; a plain Error traps.
  if (request.fail) throw Object.assign(new Error('asked to fail'), { payload: 'asked to fail' });
  return JSON.stringify({ echo: request, sum: (request.values ?? []).reduce((a, b) => a + b, 0) });
}
