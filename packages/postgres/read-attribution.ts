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

export function noteRead(site: string): void {
  counts.set(site, (counts.get(site) ?? 0) + 1);
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
    const total = Object.values(tally).reduce((sum, n) => sum + n, 0);
    console.log(`READ_ATTRIBUTION total=${total} ${JSON.stringify(tally)}`);
  });
}
