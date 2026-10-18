// Explicit unit equivalence only. Unknown units retain their caller's exact-match semantics.
const units: Record<string, { dimension: string; factor: bigint }> = {
  kg: { dimension: 'mass', factor: 1000n }, 公斤: { dimension: 'mass', factor: 1000n }, 千克: { dimension: 'mass', factor: 1000n },
  g: { dimension: 'mass', factor: 1n }, 克: { dimension: 'mass', factor: 1n },
  cup: { dimension: 'cup', factor: 1n }, cups: { dimension: 'cup', factor: 1n }, 杯: { dimension: 'cup', factor: 1n },
  piece: { dimension: 'piece', factor: 1n }, pieces: { dimension: 'piece', factor: 1n }, 件: { dimension: 'piece', factor: 1n },
  room: { dimension: 'room', factor: 1n }, rooms: { dimension: 'room', factor: 1n }, 间: { dimension: 'room', factor: 1n }, 间房: { dimension: 'room', factor: 1n },
  meal: { dimension: 'meal', factor: 1n }, meals: { dimension: 'meal', factor: 1n }, 份: { dimension: 'meal', factor: 1n },
  person: { dimension: 'person', factor: 1n }, persons: { dimension: 'person', factor: 1n }, 人: { dimension: 'person', factor: 1n },
};
export function equivalentQuantities(a: { amount: string; unit: string }, b: { amount: string; unit: string }): boolean | undefined {
  if (typeof a.unit !== 'string' || typeof b.unit !== 'string') return undefined;
  const leftName = a.unit.toLowerCase(), rightName = b.unit.toLowerCase();
  const left = Object.hasOwn(units, leftName) ? units[leftName] : undefined, right = Object.hasOwn(units, rightName) ? units[rightName] : undefined;
  if (!left || !right) return undefined;
  const scale = (q: { amount: string; unit: string }, unit: typeof left) => {
    if (!/^(0|[1-9]\d{0,17})(?:\.\d{1,6})?$/.test(q.amount) || unit.dimension !== 'mass' && q.amount.includes('.')) return undefined;
    const [whole, part = ''] = q.amount.split('.'); return (BigInt(whole!) * 1_000_000n + BigInt(part.padEnd(6, '0'))) * unit.factor;
  };
  const x = scale(a, left), y = scale(b, right);
  return x !== undefined && y !== undefined && left.dimension === right.dimension && x === y;
}
export function quantityAppearsInQuote(quote: string, expected: { amount: string; unit: string }): boolean {
  return [...quote.matchAll(/(?<![\d.])(\d+(?:\.\d{1,6})?)\s*(公斤|千克|kg|克|g|杯|cups?|件|pieces?|人|persons?|间房|间|rooms?|份|meals?)(?![A-Za-z])/gi)]
    .some(m => equivalentQuantities({ amount: m[1]!, unit: m[2]! }, expected) === true);
}
