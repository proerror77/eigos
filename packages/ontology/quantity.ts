// Explicit unit equivalence only. Unknown units retain their caller's exact-match semantics.
const units: Record<string, { dimension: string; factor: bigint }> = {
  kg: { dimension: 'mass', factor: 1000n }, 公斤: { dimension: 'mass', factor: 1000n }, 千克: { dimension: 'mass', factor: 1000n },
  g: { dimension: 'mass', factor: 1n }, 克: { dimension: 'mass', factor: 1n },
  cup: { dimension: 'cup', factor: 1n }, cups: { dimension: 'cup', factor: 1n }, 杯: { dimension: 'cup', factor: 1n },
  piece: { dimension: 'piece', factor: 1n }, pieces: { dimension: 'piece', factor: 1n }, 件: { dimension: 'piece', factor: 1n },
  room: { dimension: 'room', factor: 1n }, rooms: { dimension: 'room', factor: 1n }, 间: { dimension: 'room', factor: 1n }, 间房: { dimension: 'room', factor: 1n },
  meal: { dimension: 'meal', factor: 1n }, meals: { dimension: 'meal', factor: 1n }, 份: { dimension: 'meal', factor: 1n },
  person: { dimension: 'person', factor: 1n }, persons: { dimension: 'person', factor: 1n }, 人: { dimension: 'person', factor: 1n },
  result: { dimension: 'result_count', factor: 1n }, results: { dimension: 'result_count', factor: 1n }, 款: { dimension: 'result_count', factor: 1n }, 条: { dimension: 'result_count', factor: 1n },
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
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  // Closed, exact common counts through ninety-nine. Do not extract a suffix
  // from a larger/unsupported numeral, an ordinal, or an ambiguous digit string.
  const chinese = (value: string): string | undefined => {
    if (Object.hasOwn(digits, value)) return String(digits[value]);
    const tens = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(value);
    return tens ? String((tens[1] ? digits[tens[1]]! : 1) * 10 + (tens[2] ? digits[tens[2]]! : 0)) : undefined;
  };
  return [...quote.matchAll(/(?<![第\d.零〇一二两三四五六七八九十百千万亿])(\d+(?:\.\d{1,6})?|[零一二两三四五六七八九十]{1,3})\s*(公斤|千克|kg|克|g|杯|cups?|件|pieces?|人|persons?|间房|间|rooms?|份|meals?|款|条|results?)(?![A-Za-z])/gi)]
    .some(m => { const amount = /^\d/.test(m[1]!) ? m[1]! : chinese(m[1]!); return amount !== undefined && equivalentQuantities({ amount, unit: m[2]! }, expected) === true; });
}
