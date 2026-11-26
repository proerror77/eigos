// Compares two Engine Benchmark 08 reports, the previous one first, and fails when the kernel path regressed.
// For each size in both reports it compares the kernel's median: each read case end to end, the read after write and
// the restore. A ratio above --warn (default 1.2) is reported, and one above --fail (default 2) fails. Shared CI runners
// vary by tens of percent between runs, so the gate catches gross regressions and the warnings show the trend.
//   node scripts/benchmarks/compare.mjs previous.json current.json [--warn=1.2] [--fail=2]
import { appendFile, readFile } from 'node:fs/promises';

const [previousPath, currentPath] = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const option = (name, fallback) => Number(process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
const warn = option('warn', 1.2), fail = option('fail', 2);
const [previous, current] = await Promise.all([previousPath, currentPath].map(async path => JSON.parse(await readFile(path, 'utf8'))));
const rows = [];
for (const size of current.sizes) {
  const before = previous.sizes.find(item => item.n === size.n);
  if (!before) continue;
  const compare = (name, was, now) => {
    if (typeof was !== 'number' || typeof now !== 'number' || was <= 0) return;
    const ratio = now / was;
    rows.push({ n: size.n, name, was, now, ratio, state: ratio > fail ? 'FAIL' : ratio > warn ? 'warn' : 'ok' });
  };
  for (const read of size.reads ?? []) compare(read.case, before.reads?.find(item => item.case === read.case)?.kernel?.p50, read.kernel?.p50);
  compare('read after write', before.writes?.readAfterWrite?.p50, size.writes?.readAfterWrite?.p50);
  compare('restore', before.recovery?.restoreMs, size.recovery?.restoreMs);
}
const table = ['| N | Kernel median | Previous ms | Now ms | Ratio | |', '| --- | --- | --- | --- | --- | --- |',
  ...rows.map(row => `| ${row.n} | ${row.name} | ${row.was} | ${row.now} | ${row.ratio.toFixed(2)} | ${row.state} |`)].join('\n');
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Engine Benchmark 08 against the previous night\n\n${table}\n`);
if (rows.some(row => row.state === 'FAIL')) {
  console.error(`Kernel medians regressed by more than ${fail}x`);
  process.exitCode = 1;
}
