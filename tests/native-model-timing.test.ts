import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeModelTrace, nativeModelTimingSchema } from '../packages/capabilities/native-model-timing.js';
import { CodexExecutor } from '../packages/capabilities/executor.js';
import { withModelUsage, type ModelUsageEvidence } from '../packages/core/model-usage-context.js';

test('native timing separates MCP startup, CLI, overlapping tools and output on one monotonic clock', () => {
  let now = 100;
  const trace = new NativeModelTrace(() => now, '2026-01-01T00:00:00.000Z');
  now = 105; trace.mark('mcpReady'); now = 106; trace.mark('runStarted'); now = 110; trace.mark('spawnRequested'); now = 112; trace.mark('spawned');
  now = 114; const init = trace.start('initialize'); now = 120; trace.end(init, 'completed', 200);
  now = 121; const list = trace.start('tools_list'); now = 125; trace.end(list, 'completed', 200);
  now = 126; trace.mark('threadStarted'); now = 127; trace.mark('turnStarted');
  now = 140; trace.clientToolStarted('a', 'read_task_context'); now = 142; const request = trace.start('tool_request', 'read_task_context');
  now = 143; const handler = trace.start('server_tool', 'read_task_context'); now = 150; trace.clientToolStarted('b', 'query_ontology');
  now = 155; trace.end(handler, 'completed'); now = 158; trace.end(request, 'completed', 200);
  now = 160; trace.clientToolCompleted('a', 'read_task_context', false); now = 170; trace.clientToolCompleted('b', 'query_ontology', false);
  now = 180; trace.mark('firstOutput'); trace.mark('lastOutput'); now = 185; trace.mark('turnCompleted'); now = 188; trace.mark('processExited'); now = 190; trace.mark('outputParsed');
  const timing = trace.finish('succeeded'); assert(nativeModelTimingSchema.safeParse(timing).success);
  assert.equal(timing.totalMs, 90); assert.equal(timing.toolCatalogReadyBeforeTurn, true);
  assert.deepEqual(timing.durations, {
    mcpSetupMs: 5, localPreparationMs: 4, processSpawnMs: 2, cliToThreadMs: 16, cliToTurnMs: 17, cliBeforeMcpRequestMs: 4,
    mcpInitializeMs: 6, mcpToolsListMs: 4, mcpHandshakeMs: 11, mcpReadyToTurnMs: 2, turnToFirstToolMs: 13,
    clientToolObservedMs: 30, mcpToolRequestObservedMs: 16, serverToolObservedMs: 12, turnOutsideToolsMs: 28,
    turnToFirstOutputMs: 53, turnToFinalOutputMs: null, turnMs: 58, afterTurnMs: 3, outputReadMs: 2,
  });
  now = 1000; trace.mark('lastOutput'); assert.deepEqual(trace.snapshot(), timing, 'Late events cannot change a finished receipt');
});

test('unfinished and missing timing boundaries remain unknown and startup races remain visible', () => {
  let now = 0; const trace = new NativeModelTrace(() => now);
  trace.mark('runStarted'); trace.mark('spawnRequested'); now = 10; trace.mark('turnStarted'); now = 20; trace.clientToolStarted('private-call-id', 'read_task_context');
  now = 50; const timedOut = trace.finish('timed_out');
  assert.equal(timedOut.stage, 'tool_call'); assert.equal(timedOut.durations.clientToolObservedMs, 30);
  assert.equal(timedOut.spans[0]!.status, 'pending'); assert.equal(timedOut.spans[0]!.durationMs, undefined);
  assert.equal(timedOut.durations.turnMs, null); assert.equal(timedOut.durations.turnToFirstOutputMs, null); assert.equal(timedOut.toolCatalogReadyBeforeTurn, null);
  const missing = new NativeModelTrace(() => now); missing.clientToolCompleted('completed-without-start', 'query_ontology', false);
  const span = missing.finish('failed').spans[0]!; assert.equal(span.startedMs, undefined); assert.equal(span.durationMs, undefined);
  now = 100; const race = new NativeModelTrace(() => now); race.mark('turnStarted'); now = 110; const list = race.start('tools_list'); now = 115; race.end(list, 'completed', 200);
  const raced = race.finish('failed'); assert.equal(raced.toolCatalogReadyBeforeTurn, false); assert.equal(raced.durations.mcpReadyToTurnMs, null);
  const denied = new NativeModelTrace(() => now); const refused = denied.start('tools_list'); now++; denied.end(refused, 'failed', 403); now++; denied.mark('turnStarted');
  const denial = denied.finish('failed'); assert.equal(denial.toolCatalogReadyBeforeTurn, false); assert.equal(denial.durations.mcpReadyToTurnMs, null, 'A rejected tool catalog is not readiness');
});

test('native diagnostics bound event storage and exclude arbitrary names, IDs and payload fields', () => {
  let now = 0; const trace = new NativeModelTrace(() => now);
  for (let i = 0; i < 120; i++) { const span = trace.start('server_tool', 'PRIVATE_UNTRUSTED_TOOL'); now++; trace.end(span, 'completed', 200); }
  const timing = trace.finish('failed'); assert.equal(timing.spans.length, 96); assert.equal(timing.omittedSpans, 24);
  assert(timing.spans.every(span => span.tool === 'other')); assert(!JSON.stringify(timing).includes('PRIVATE_'));
  assert(!nativeModelTimingSchema.safeParse({ ...timing, prompt: 'PRIVATE_PROMPT' }).success);
  assert(!nativeModelTimingSchema.safeParse({ ...timing, totalMs: Infinity }).success);
});

function executableFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-native-timing-')), binary = join(directory, 'model-fixture');
  writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs'); let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
 const emit = event => console.log(JSON.stringify(event));
 emit({type:'thread.started',thread_id:'synthetic-thread'}); emit({type:'turn.started'});
 emit({type:'item.started',item:{id:'PRIVATE_CALL_ID',type:'mcp_tool_call',server:'eigos_ontology',tool:'read_task_context',arguments:{secret:'PRIVATE_ARGUMENT'}}});
 if(input === 'timeout' || input === 'interrupt') { setInterval(() => {}, 1000); return; }
 setTimeout(() => {
  emit({type:'item.completed',item:{id:'PRIVATE_CALL_ID',type:'mcp_tool_call',server:'eigos_ontology',tool:'read_task_context',status:'completed',result:{content:[{type:'text',text:'PRIVATE_RESULT'}]}}});
  emit({type:'item.completed',item:{type:'agent_message',phase:'final_answer',text:'PRIVATE_OUTPUT'}});
  fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],input === 'invalid' ? 'not-json' : '{"ok":true}');
  emit({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});
 }, 20);
});`, { mode: 0o700 });
  return { binary, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('successful exec receipts include phase timing without copying model or tool contents', async () => {
  const fixture = executableFixture();
  try {
    const result = await new CodexExecutor(fixture.binary, 5000).runStructured('success', {}, new AbortController().signal);
    assert.deepEqual(result.output, { ok: true }); const timing = result.evidence.nativeTiming!;
    assert(nativeModelTimingSchema.safeParse(timing).success); assert.equal(timing.outcome, 'succeeded');
    assert(timing.markers.spawned !== undefined && timing.markers.turnStarted !== undefined && timing.markers.outputParsed !== undefined);
    assert.equal(timing.spans.length, 1); assert.equal(timing.spans[0]!.tool, 'read_task_context'); assert.equal(timing.spans[0]!.status, 'completed');
    assert(timing.durations.turnToFirstToolMs! >= 0); assert(timing.durations.turnToFirstOutputMs! >= 0); assert(!JSON.stringify(timing).includes('PRIVATE_'));
    assert.equal(timing.markers.finalOutput, timing.markers.lastOutput); assert.equal(timing.outputBoundary, 'completed_message');
  } finally { fixture.close(); }
});

test('native preparation includes durable attempt registration before spawning the model', async () => {
  const fixture = executableFixture(); let now = 0;
  const trace = new NativeModelTrace(() => now);
  try {
    const result = await withModelUsage({ begin: () => { now = 40; }, finish: () => {} }, () => new CodexExecutor(fixture.binary, 5000).runStructured('success', {}, new AbortController().signal,
      { mcp: { name: 'eigos_ontology', url: 'http://127.0.0.1:43210/mcp', token: 'synthetic-token', tools: ['read_task_context'], trace } }));
    assert.equal(result.evidence.nativeTiming!.markers.runStarted, 0);
    assert.equal(result.evidence.nativeTiming!.durations.localPreparationMs, 40, 'Registration latency must not disappear before the preparation boundary');
  } finally { fixture.close(); }
});

for (const mode of ['timeout', 'interrupt', 'invalid'] as const) test(`exec ${mode} retains observed timing without fabricating a successful output receipt`, async () => {
  const fixture = executableFixture(), controller = new AbortController(); let recorded: ModelUsageEvidence | undefined, state: string | undefined;
  class InterruptingTrace extends NativeModelTrace {
    override clientToolStarted(id: string, tool: string) { super.clientToolStarted(id, tool); if (mode === 'interrupt') controller.abort(); }
  }
  try {
    await withModelUsage({ begin: () => {}, finish: (_id, evidence, outcome) => { recorded = evidence; state = outcome; } }, async () => {
      await assert.rejects(new CodexExecutor(fixture.binary, 5000).runStructured(mode, {}, controller.signal,
        { mcp: { name: 'eigos_ontology', url: 'http://127.0.0.1:43210/mcp', token: 'PRIVATE_SESSION_TOKEN', tools: ['read_task_context'], trace: new InterruptingTrace() } }));
    });
    assert(recorded?.nativeTiming); assert.equal(state, mode === 'interrupt' ? 'interrupted' : 'failed');
    assert.equal(recorded.nativeTiming.outcome, mode === 'timeout' ? 'timed_out' : mode === 'interrupt' ? 'interrupted' : 'invalid_result');
    assert.equal(recorded.nativeTiming.stage, mode === 'invalid' ? 'output_validation' : 'tool_call');
    assert(!Object.hasOwn(recorded, 'outputSha256')); assert(!JSON.stringify(recorded).includes('PRIVATE_'));
  } finally { fixture.close(); }
});
