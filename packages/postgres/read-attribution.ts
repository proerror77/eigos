/**
 * Attribution for the read-amplification audit: which call site hands the
 * database the same work over and over. Counters only — no caching, no
 * shortcuts, no behaviour change. The DiDi trace counted ~8,000 security
 * statements per task but could not say whether they came from per-reference
 * binding reads, from the admission fence select, or from the batched path.
 *
 * Set EIGOS_READ_ATTRIBUTION=1 to print the tally at process exit.
 */
const counts = new Map<string, number>();
const keys = new Map<string, Set<string>>();

export function noteRead(site: string, key?: string): void {
  counts.set(site, (counts.get(site) ?? 0) + 1);
  if (key !== undefined) {
    const seen = keys.get(site) ?? new Set<string>();
    seen.add(key);
    keys.set(site, seen);
  }
}

/** Calls vs distinct keys: tells repetition within one client from fan-out. */
export function readAttributionKeys(): Record<string, {calls: number; distinct: number}> {
  return Object.fromEntries([...counts.entries()].map(([site, calls]) => [site, {calls, distinct: keys.get(site)?.size ?? 0}]));
}

export function readAttribution(): Record<string, number> {
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]));
}

export function resetReadAttribution(): void {
  counts.clear();
}

if (process.env.EIGOS_READ_ATTRIBUTION === '1') {
  process.once('exit', () => {
    const tally = readAttribution();
    console.log(`READ_ATTRIBUTION_KEYS ${JSON.stringify(readAttributionKeys())}`);
    const total = Object.values(tally).reduce((sum, n) => sum + n, 0);
    console.log(`READ_ATTRIBUTION total=${total} ${JSON.stringify(tally)}`);
  });
}
