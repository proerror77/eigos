import { spawn } from 'node:child_process';
import { scopeFromGit, shardFiles, testFiles } from './test-scope.mjs';

const args = process.argv.slice(2), e2e = args.includes('--e2e'), changed = args.includes('--changed');
const base = args.find(arg => arg.startsWith('--base='))?.slice(7) || 'origin/main';
const shard = args.find(arg => arg.startsWith('--test-shard='));
const nodeArgs = args.filter(arg => !['--changed', '--e2e', '--list'].includes(arg) && !arg.startsWith('--base=') && arg !== shard);
const available = testFiles(process.cwd(), e2e);
let files = available;
if (process.env.EIGOS_TEST_FILES !== undefined) {
  files = JSON.parse(process.env.EIGOS_TEST_FILES);
  if (!Array.isArray(files) || files.some(file => !available.includes(file)) || new Set(files).size !== files.length) {
    throw new Error('EIGOS_TEST_FILES must contain distinct current test files from the selected suite');
  }
} else if (changed) {
  const scope = await scopeFromGit({ base });
  console.log(`Test scope: ${scope.mode} (${scope.reason})`);
  files = e2e ? scope.e2e : scope.unit;
}
if (shard) {
  const match = /^--test-shard=([1-9]\d*)\/([1-9]\d*)$/.exec(shard);
  if (!match || Number(match[1]) > Number(match[2])) throw new Error('Expected --test-shard=index/count');
  files = shardFiles(files, Number(match[2]))[Number(match[1])];
}
console.log(`Selected ${files.length}/${available.length} ${e2e ? 'process E2E' : 'unit/integration'} test files.`);
if (args.includes('--list')) console.log(files.join('\n'));
else if (!files.length) console.log('No tests in this scope; test discovery was not invoked.');
else {
  const paths = e2e ? files.map(file => 'dist/' + file.replace(/\.ts$/, '.js')) : files;
  const child = spawn(process.execPath, [...(e2e ? [] : ['--import', 'tsx']), '--test', `--test-concurrency=${e2e ? 1 : 2}`, ...nodeArgs, ...paths], { stdio: 'inherit' });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('close', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}
