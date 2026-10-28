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
    assert(!args.some(arg => arg.startsWith('mcp_servers.')), 'Document-only runs do not acquire Ontology tools');
    assert.deepEqual(result.evidence.modelConfiguration, DEFAULT_WORKER_MODEL); assert.equal(result.evidence.model, undefined); assert(result.evidence.durationMs! >= 0);
    const config = readWorkerConfig({}); assert.equal(config.EIGOS_CODEX_MODEL, 'gpt-6-luna'); assert.equal(config.EIGOS_CODEX_SERVICE_TIER, 'priority');
    assert.throws(() => readWorkerConfig({ EIGOS_CODEX_SERVICE_TIER: 'unadvertised' }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Native Ontology planning waits for its required MCP server within the original startup and tool limits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-native-model-')), binary = join(dir, 'model-fixture');
  writeFileSync(binary, `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{const fs=require('node:fs');fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],JSON.stringify({args:process.argv.slice(2)}));console.log(JSON.stringify({type:'turn.completed'}));});`, { mode: 0o700 });
  try {
    const tools = ['read_task_context', 'submit_decision'];
    const result = await new CodexExecutor(binary).runStructured('synthetic native planning', {}, new AbortController().signal,
      { mcp: { name: 'eigos_ontology', url: 'http://127.0.0.1:43210/mcp', token: 'synthetic-session-token', tools } });
    const args = (result.output as { args: string[] }).args;
    assert(args.includes('mcp_servers.eigos_ontology.required=true'), 'An optional server can be omitted from the initial model tool catalog before its startup timeout');
    assert(args.includes('mcp_servers.eigos_ontology.startup_timeout_sec=15'));
    assert(args.includes('mcp_servers.eigos_ontology.tool_timeout_sec=30'));
    assert(args.includes(`mcp_servers.eigos_ontology.enabled_tools=${JSON.stringify(tools)}`));
    assert(!args.join(' ').includes('synthetic-session-token'), 'The session credential stays out of command arguments');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
