import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexExecutor, DEFAULT_WORKER_MODEL } from '../packages/capabilities/executor.js';
import { readWorkerConfig } from '../packages/core/config.js';

test('Worker pins Luna Fast independently of user defaults and distinguishes requested configuration from observed model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-model-')), binary = join(dir, 'model-fixture');
  writeFileSync(binary, `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{const fs=require('node:fs');fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],JSON.stringify({args:process.argv.slice(2)}));console.log(JSON.stringify({type:'turn.completed'}));});`, { mode: 0o700 });
  try {
    const result = await new CodexExecutor(binary).runStructured('fixture', {}, new AbortController().signal), args = (result.output as { args: string[] }).args;
    assert(args.includes('--ignore-user-config')); assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-luna');
    assert(args.includes('model_reasoning_effort="medium"')); assert(args.includes('service_tier="priority"'));
    assert.deepEqual(result.evidence.modelConfiguration, DEFAULT_WORKER_MODEL); assert.equal(result.evidence.model, undefined); assert(result.evidence.durationMs! >= 0);
    const config = readWorkerConfig({}); assert.equal(config.EIGOS_CODEX_MODEL, 'gpt-6-luna'); assert.equal(config.EIGOS_CODEX_SERVICE_TIER, 'priority');
    assert.throws(() => readWorkerConfig({ EIGOS_CODEX_SERVICE_TIER: 'unadvertised' }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
