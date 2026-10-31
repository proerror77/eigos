import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function testFiles(root = process.cwd(), e2e = false) {
  const directory = e2e ? 'tests/e2e' : 'tests';
  return readdirSync(resolve(root, directory)).filter(name => /\.test\.(ts|mjs)$/.test(name))
    .sort().map(name => `${directory}/${name}`);
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function changedFiles(root, base = 'origin/main') {
  const mergeBase = git(root, ['merge-base', base, 'HEAD']).trim();
  // Include committed, staged, unstaged, deleted and new files. Disabling rename
  // detection keeps both paths, so a move cannot hide the old dependants.
  return [...new Set([
    ...git(root, ['diff', '--name-only', '--no-renames', '-z', mergeBase, '--']).split('\0'),
    ...git(root, ['diff', '--cached', '--name-only', '--no-renames', '-z', mergeBase, '--']).split('\0'),
    ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ].filter(Boolean))].sort();
}

function documentation(file) {
  return ['AGENTS.md', 'README.md'].includes(file)
    || /^docs\/.*\.md$/.test(file) || /^packages\/.*\/README\.md$/.test(file);
}

export function shardFiles(files, count = 8) {
  // This sequential journey can consume most of a hosted runner's job budget.
  // Keep it separate from ordinary suites without changing coverage or checks.
  const longSuite = 'tests/stripe-payment.test.ts';
  if (count > 1 && files.includes(longSuite)) {
    const rest = files.filter(file => file !== longSuite);
    return { ...shardFiles(rest, count - 1), [count]: files.filter(file => file === longSuite) };
  }
  return Object.fromEntries(Array.from({ length: count }, (_, index) =>
    [index + 1, files.filter((_, position) => position % count === index)]));
}

async function dependencyGraph(root) {
  root = realpathSync(root);
  // esbuild is already used by tsx. Its resolver handles .js -> .ts, re-exports,
  // cycles and literal dynamic imports, while excluding erased type-only imports.
  const { build } = await import('esbuild');
  const files = [...new Set(git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0'))]
    .filter(file => /^(apps|packages|tests|examples|scripts)\/.*\.(ts|mjs)$/.test(file)
      && existsSync(resolve(root, file)) && statSync(resolve(root, file)).isFile()).sort();
  const result = await build({
    absWorkingDir: root,
    stdin: { contents: files.map(file => `import ${JSON.stringify('./' + file)};`).join('\n'), resolveDir: root },
    bundle: true, write: false, metafile: true, packages: 'external', platform: 'node', format: 'esm',
    treeShaking: false, logLevel: 'silent',
    plugins: [{ name: 'built-entrypoints', setup(builder) {
      builder.onResolve({ filter: /\.js$/ }, args => {
        if (!args.path.startsWith('.')) return;
        const path = resolve(args.resolveDir, args.path), prefix = resolve(root, 'dist') + '/';
        if (path.startsWith(prefix)) return { path: resolve(root, path.slice(prefix.length).replace(/\.js$/, '.ts')) };
      });
    } }],
  });
  const reverse = new Map();
  const edge = (dependency, consumer) => {
    if (!reverse.has(dependency)) reverse.set(dependency, new Set());
    reverse.get(dependency).add(consumer);
  };
  for (const [consumer, input] of Object.entries(result.metafile.inputs)) {
    if (consumer === '<stdin>') continue;
    for (const dependency of input.imports) if (!dependency.external) edge(dependency.path, consumer);
  }
  // Process entry points and fixture files are also referenced as paths rather
  // than imports. Include literal paths, directory prefixes and the literal head
  // of templates such as `./child.${source ? 'ts' : 'js'}` conservatively.
  for (const consumer of files) {
    const source = readFileSync(resolve(root, consumer), 'utf8');
    for (const match of source.matchAll(/["'`]((?:\.\.?\/|(?:dist\/)?(?:apps|packages|tests|examples|scripts)\/)[^"'`\s$]*)/g)) {
      // Static imports are already resolved above. Do not reintroduce erased
      // type dependencies when collecting non-import path references.
      if (/\b(?:from|import)\s*(?:\(\s*)?$/.test(source.slice(0, match.index))) continue;
      const reference = match[1];
      const path = reference.startsWith('.') ? posix.normalize(posix.join(posix.dirname(consumer), reference)) : reference.replace(/^dist\//, '');
      const candidate = path.replace(/^dist\//, '').replace(/\.js$/, '.ts');
      for (const file of files) {
        if (file === candidate || file.startsWith(candidate.replace(/\/$/, '') + '/')
          || (candidate.endsWith('.') && file.startsWith(candidate))) edge(file, consumer);
      }
    }
  }
  return reverse;
}

export async function selectScope({ root = process.cwd(), changed, full = false, main = false, reason } = {}) {
  const unit = testFiles(root), e2e = testFiles(root, true);
  const all = why => ({ mode: 'full', reason: why, verify: true, unit, e2e });
  if (full) return all(reason ?? 'Explicit full regression');
  const relevant = changed.filter(file => !documentation(file));
  if (!relevant.length) return { mode: 'docs', reason: 'Only documentation or no changes', verify: false, unit: [], e2e: [] };
  if (main) return all('Integration branch regression');
  const unscoped = relevant.find(file => !/^(apps|packages|tests|examples)\/.*\.(ts|mjs)$/.test(file)
    || !existsSync(resolve(root, file)));
  if (unscoped) return all(`Configuration, runtime data, tooling, deletion or unknown path: ${unscoped}`);
  let graph;
  try { graph = await dependencyGraph(root); }
  catch { return all('Dependency graph could not be resolved'); }
  const dependants = file => {
    const found = new Set([file]), queue = [file];
    for (const dependency of queue) {
      for (const consumer of graph.get(dependency) ?? []) {
        if (!found.has(consumer)) { found.add(consumer); queue.push(consumer); }
      }
    }
    return found;
  };
  const affected = new Set();
  for (const file of relevant) {
    const found = dependants(file);
    if (![...unit, ...e2e].some(test => found.has(test))) return all(`No known test dependants: ${file}`);
    for (const consumer of found) affected.add(consumer);
  }
  const selected = unit.filter(file => affected.has(file));
  // Keep independent process coverage for all production and shared-fixture
  // changes: subprocess/configuration edges cannot all be inferred statically.
  const processCoverage = relevant.some(file => !unit.includes(file) && !e2e.includes(file));
  const selectedE2e = processCoverage ? e2e : e2e.filter(file => affected.has(file));
  if (!selected.length && !selectedE2e.length) return all('No tests could be selected for code changes');
  return { mode: 'affected', reason: 'Changed tests and transitive dependants', verify: true, unit: selected, e2e: selectedE2e };
}

export async function scopeFromGit({ root = process.cwd(), base = 'origin/main', full = false, main = false } = {}) {
  if (full) return selectScope({ root, full });
  let changed;
  try { changed = changedFiles(root, base); }
  catch { return selectScope({ root, full: true, reason: 'Comparison base unavailable; running full regression' }); }
  return selectScope({ root, changed, main });
}

async function main() {
  const args = process.argv.slice(2), ci = args.includes('--ci');
  const base = args.find(arg => arg.startsWith('--base='))?.slice(7) || process.env.CI_BASE_SHA || 'origin/main';
  const scope = await scopeFromGit({ base, full: args.includes('--full') || (ci && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'),
    main: ci && process.env.GITHUB_EVENT_NAME === 'push' });
  console.log(JSON.stringify(scope, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    const outputs = { mode: scope.mode, verify: scope.verify, shards: shardFiles(scope.unit), e2e: scope.e2e };
    for (const [key, value] of Object.entries(outputs)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### Test scope: ${scope.mode}\n\n${scope.reason}\n\nUnit/integration files: ${scope.unit.length}; process E2E files: ${scope.e2e.length}.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
