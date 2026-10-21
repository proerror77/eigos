// Every CLI response is synthetic, including the resulting live-shaped receipt.
// This exercises local runtime wiring; it proves no live provider or PA/model result.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { createApp } from '../apps/gateway/app.js';
import { createWorker } from '../apps/worker/runtime.js';
import { readConfig, readWorkerConfig } from '../packages/core/config.js';
import { digest } from '../packages/core/delegation.js';
import { validatePlan } from '../packages/coordinator/plan.js';
import type { Job } from '../packages/core/domain.js';
import type { Reasoner } from '../packages/coordinator/coordinator.js';
import { PAOTUI_READ_CAPABILITIES } from '../packages/capabilities/paotui-ontology.js';
import { owner, principal, proposal, observePlanning, observeTaskContext } from './backend-fixture.js';

const query = { city: '北京市', keyword: '天安门' };
const deniedQuery = { city: '北京市', keyword: '故宫博物院' };
const capability = PAOTUI_READ_CAPABILITIES[0]!;
const sourceId = 'meituan:public-geo-discovery';
type Command = { command: string; args: string[] };
const evidence = () => ({ id: randomUUID(), runtime: 'synthetic-public-geo-runtime-no-model', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), outputSha256: 'synthetic-fixture' });

function fixedReasoner(input = query): Reasoner {
  return {
    ground: async (request, _caps, _signal, access) => { request = observeTaskContext(access) ?? request; return { decision: {
      kind: 'resolve', requestRevision: request.revision, capabilityRef: capability.ref,
      message: 'Synthetic fixed public query; no model was called', inputJson: JSON.stringify(input),
      // Reproduce the real PA interpreter's city requirement, rather than hiding it.
      requirementsJson: JSON.stringify([{ requirement: { id: 'public-location-scope', strength: 'hard', kind: 'location', expected: { ref: '北京市' } }, messageId: request.messages[0]!.id, quote: '北京市' }]),
      conditionsJson: '[]',
    }, evidence: evidence() }; },
    plan: async (context, _signal, access) => { observePlanning(context, access); return { decision: context.resolution.candidates.some(candidate => candidate.status === 'ready')
      ? proposal(context) : { kind: 'no_feasible_plan', requestRevision: context.request.revision, candidateId: '', steps: [],
        message: 'Synthetic fixed planner received no verified public query result' }, evidence: evidence() }; },
  };
}

async function terminal(read: () => Job): Promise<Job> {
  const deadline = Date.now() + 15000;
  while (true) {
    const job = read();
    if (!['submitted', 'working'].includes(job.state)) return job;
    if (Date.now() >= deadline) throw new Error(`Synthetic runtime did not settle: ${JSON.stringify({ state: job.state, error: job.error, phase: job.delegation?.phase, coverage: job.delegation?.resolution?.scope.coverage, events: job.delegation?.events })}`);
    await pause(25);
  }
}

function fakeCli(directory: string, failure: boolean) {
  const bin = join(directory, 'bin'); const skill = join(directory, 'synthetic-paotui');
  mkdirSync(bin); mkdirSync(skill);
  const commands = join(directory, 'commands.jsonl');
  const passportCalls = join(directory, 'synthetic-passport-calls.txt');
  const quotedPassportCalls = "'" + passportCalls.replaceAll("'", "'\\''") + "'";
  // Shell built-ins only. The fixed output is a nonsecret test sentinel and never
  // comes from the real passport cache; PATH excludes the user's executables.
  writeFileSync(join(bin, 'pt-passport'), '#!/bin/sh\n[ "$1" = "get-token" ] && [ "$2" = "--client_id" ] && [ "$#" = 3 ] || exit 91\nprintf "%s\\n" "get-token" >> ' + quotedPassportCalls + '\nprintf "%s\\n" "synthetic-runtime-token-not-a-credential"\n', { mode: 0o700 });
  writeFileSync(join(skill, 'paotui.js'), `const fs = require('node:fs');
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(commands)}, JSON.stringify({ command: args[0], args: args.slice(1) }) + '\\n');
assert.equal(process.env.MCP_ACCESS_TOKEN, 'synthetic-runtime-token-not-a-credential');
assert.deepEqual(args, ['search_poi', '--keyword', '天安门', '--city', '北京市']);
${failure ? "console.error('PRIVATE_SYNTHETIC_PROVIDER_ERROR'); process.exit(2);" : "console.log(JSON.stringify({ status: 'ok', pois: [{ name: 'Synthetic public landmark', address: 'Synthetic public square', city: '北京市', lat: 39904200, lng: 116407400, poiId: 'synthetic-poi' }] }));"}
`);
  return { bin, skill, calls: (): Command[] => existsSync(commands) ? readFileSync(commands, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Command) : [],
    tokenReads: () => existsSync(passportCalls) ? readFileSync(passportCalls, 'utf8').trim().split('\n').filter(Boolean).length : 0 };
}

for (const mode of ['success', 'denied', 'provider_failure'] as const) test(`Gateway/Worker public discovery runtime ${mode} with synthetic CLI only`, { timeout: 30000, concurrency: false }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-public-geo-runtime-'));
  const fixture = fakeCli(directory, mode === 'provider_failure'); const previousPath = process.env.PATH;
  process.env.PATH = `${fixture.bin}:/usr/bin:/bin`;
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test', EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'synthetic-development-token-for-runtime-tests-only',
    DATABASE_PATH: join(directory, 'tasks.sqlite'), MEMBERSHIP_DATABASE_PATH: join(directory, 'members.sqlite'),
    EIGOS_PAOTUI_SKILL_DIR: fixture.skill, EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES: JSON.stringify([query]),
    EIGOS_EXECUTOR: 'disabled', EIGOS_CODEX_BIN: '/synthetic-model-must-never-run',
  };
  let gateway: ReturnType<typeof createApp> | undefined;
  let worker: ReturnType<typeof createWorker> | undefined;
  try {
    gateway = createApp(readConfig(env));
    assert.equal(gateway.catalog.discoverySources(capability.ref, owner).length, 1, 'Gateway must wire the configured discovery source');
    assert.deepEqual(gateway.catalog.bindings(capability.ref, owner), [], 'opt-in must replace the unrestricted static search binding');
    const submitted = gateway.tasks.submit(principal, { service: 'eigos.delegate', goal: 'Synthetic public search fixture for 北京市; no model or actual provider', requestId: randomUUID() });
    assert.equal(submitted.state, 'submitted');
    assert.deepEqual(fixture.calls(), [], 'Gateway must only enqueue, never invoke the CLI');
    assert.equal(fixture.tokenReads(), 0);
    worker = createWorker(readWorkerConfig(env), { reasoner: fixedReasoner(mode === 'denied' ? deniedQuery : query), timing: { pollMs: 25, leaseMs: 10000, timeoutMs: 15000 } });
    const completed = await terminal(() => gateway!.tasks.get(principal, submitted.id));
    assert.equal(completed.id, submitted.id);
    assert.equal(completed.delegation?.resolution?.scope.realSupply, false);
    assert.equal(completed.delegation?.resolution?.comparison, undefined);
    const coverage = completed.delegation!.resolution!.scope.coverage!;
    assert.equal(coverage.length, 1);
    assert.equal(coverage[0]!.sourceId, sourceId);
    assert.equal(coverage[0]!.realSupply, false);
    assert.equal(completed.runs?.length, 2);
    assert(completed.runs!.every(run => run.runtime === 'synthetic-public-geo-runtime-no-model'));
    assert(!JSON.stringify(completed).includes('PRIVATE_SYNTHETIC_PROVIDER_ERROR'));
    assert(!JSON.stringify(completed).includes('synthetic-runtime-token-not-a-credential'));
    assert.equal(fixture.tokenReads(), mode === 'denied' ? 0 : 1, 'denied queries must not attempt even the fake credential lookup');
    if (mode === 'success') {
      assert.equal(completed.state, 'completed');
      assert.equal(coverage[0]!.status, 'returned');
      const candidate = completed.delegation!.resolution!.candidates[0]!;
      assert.equal(completed.delegation!.resolution!.candidates.length, 1);
      assert.equal(candidate.binding.discovery?.sourceId, sourceId, 'Worker must use DiscoverySource, not the legacy static adapter');
      assert.equal(candidate.binding.discovery?.requestId, submitted.id);
      assert.equal(candidate.binding.discovery?.requestRevision, 1);
      assert.equal(candidate.offer, undefined);
      assert.deepEqual(candidate.facts.searchArea, query);
      assert.equal(candidate.requirementChecks.find(check => check.requirementId === 'public-location-scope')?.result, 'pass');
      assert.equal(candidate.binding.configurationDigest, gateway.catalog.discoverySources(capability.ref, owner)[0]!.configurationDigest);
      assert.equal(completed.delegation!.acceptance!.accepted, true);
      assert.equal(completed.delegation!.plan!.completionTarget, 'artifact');
      const result = completed.artifact!.data.result as { places: { name: string; lat: number; lng: number; coordinateUnit: string }[]; ontologyReceipt: { evidenceKind: string; inputDigest: string; sourceCalls: string[] } };
      assert.deepEqual(result.places, [{ name: 'Synthetic public landmark', address: 'Synthetic public square', city: '北京市', lat: 39.9042, lng: 116.4074, coordinateUnit: 'degree', poiId: 'synthetic-poi' }]);
      assert.equal(result.ontologyReceipt.evidenceKind, 'live_readonly', 'synthetic CLI exercises this receipt shape; it is not live-source proof');
      assert.equal(result.ontologyReceipt.inputDigest, digest(query));
      assert.deepEqual(result.ontologyReceipt.sourceCalls, ['search_poi']);
      assert.deepEqual(fixture.calls(), [{ command: 'search_poi', args: ['--keyword', query.keyword, '--city', query.city] }], 'execution must reuse the discovery read');
    } else {
      assert.equal(completed.state, 'rejected');
      assert.equal(completed.artifact, undefined);
      assert.equal(completed.delegation!.plan, undefined);
      assert.deepEqual(completed.delegation!.resolution!.candidates, []);
      assert.equal(coverage[0]!.status, mode === 'denied' ? 'needs_authorization' : 'unavailable');
      assert.equal(fixture.calls().length, mode === 'denied' ? 0 : 1);
    }
    await worker.close(); worker = undefined;
    await gateway.close(); gateway = undefined;
    gateway = createApp(readConfig(env));
    const reopened = gateway.tasks.get(principal, submitted.id);
    assert.equal(reopened.id, submitted.id);
    assert.equal(reopened.state, completed.state);
    assert.deepEqual(reopened.artifact, completed.artifact);
    assert.deepEqual(reopened.delegation!.resolution, completed.delegation!.resolution);
    assert.deepEqual(reopened.delegation!.acceptance, completed.delegation!.acceptance);
    if (mode === 'success') {
      validatePlan(gateway.catalog, owner, reopened.delegation!.request, reopened.delegation!.plan!, gateway.store.ontologyForJob(owner, reopened).model.ref);
      assert.equal(reopened.delegation!.actions!.length, 1);
      assert.equal(reopened.delegation!.actions![0]!.state, 'effect_confirmed');
      assert.deepEqual(reopened.delegation!.businessFacts, []);
    }
    assert.equal(fixture.calls().length, mode === 'denied' ? 0 : 1, 'durable readback must never repeat the provider read');
    assert.equal(fixture.tokenReads(), mode === 'denied' ? 0 : 1);
  } finally {
    try { await worker?.close(); }
    finally {
      try { await gateway?.close(); }
      finally {
        if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }
});
