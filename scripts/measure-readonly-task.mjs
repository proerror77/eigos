#!/usr/bin/env node
// Explicit candidate-code measurement. The identity and stores are isolated;
// the configured model and the two allowlisted DiDi read tools are real.
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { JobStore } from '../dist/packages/core/store.js';
import { MemberStore } from '../dist/packages/members/store.js';
import { SCOPES, ownerKey } from '../dist/packages/core/domain.js';
import { bindPersonalSourceOwner } from '../dist/packages/core/source-owner.js';
import { ExecutionCatalog } from '../dist/packages/core/catalog.js';
import { TaskService } from '../dist/packages/core/tasks.js';
import { AuthorizationCoordinator } from '../dist/packages/security/coordinator.js';
import { taskContextFields } from '../dist/packages/security/task-context-contract.js';
import { DidiAgentProgram } from '../dist/packages/capabilities/didi/program.js';
import { DidiMcpConnector } from '../dist/packages/capabilities/didi/connector.js';
import { CodexExecutor } from '../dist/packages/capabilities/executor.js';
import { Coordinator, CodexReasoner } from '../dist/packages/coordinator/coordinator.js';
import { Worker } from '../dist/apps/worker/worker.js';

const { values } = parseArgs({ options: { config: { type: 'string' }, output: { type: 'string' }, city: { type: 'string' }, origin: { type: 'string' }, destination: { type: 'string' },
  class: { type: 'string', default: '专车' }, 'run-readonly': { type: 'boolean', default: false } } });
if (!values.config || !isAbsolute(values.config) || !values.output || !isAbsolute(values.output) || !values.city || !values.origin || !values.destination) throw new Error('Provide private --config, new absolute --output, --city, --origin and --destination');
const stat = lstatSync(values.config);
if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new Error('Use an owned private configuration file');
if (!values['run-readonly']) { console.log(JSON.stringify({ status: 'prepared', route: { city: values.city, origin: values.origin, destination: values.destination }, noOrderOrPayment: true })); process.exit(0); }
const settings = parseEnv(readFileSync(values.config, 'utf8'));
for (const key of ['EIGOS_DIDI_KEY_FILE', 'EIGOS_DIDI_KEY_SHA256', 'EIGOS_DIDI_BINDING_ID', 'EIGOS_CODEX_BIN', 'EIGOS_CODEX_MODEL']) if (!settings[key]) throw new Error(`Missing configured ${key}`);
if (settings.EIGOS_DIDI_ENVIRONMENT !== 'production') throw new Error('This measurement requires the production read-only source');
mkdirSync(values.output, { mode: 0o700 });
const harnessStart = performance.now(), spans = [], rpc = [], begin = (kind, detail = {}) => {
  const entry = { kind, ...detail, startedMs: performance.now() - harnessStart }; spans.push(entry);
  return () => { entry.completedMs = performance.now() - harnessStart; entry.durationMs = entry.completedMs - entry.startedMs; };
};
const binding = { bindingId: settings.EIGOS_DIDI_BINDING_ID, keyFile: settings.EIGOS_DIDI_KEY_FILE, keySha256: settings.EIGOS_DIDI_KEY_SHA256,
  environment: 'production', auditDirectory: join(values.output, 'source-audit') };
const transport = async (url, init = {}) => {
  let request; try { request = JSON.parse(String(init.body)); } catch { /* GET/DELETE are MCP transport maintenance. */ }
  const method = request?.method ?? init.method ?? 'GET', tool = request?.params?.name;
  if (method === 'tools/call' && !['maps_textsearch', 'taxi_estimate'].includes(tool)) throw new Error('A non-read source request is forbidden');
  if (method === 'tools/call' && rpc.filter(value => value.method === 'tools/call').length >= 3) throw new Error('The measurement read budget is exhausted');
  const entry = { method, ...(tool ? { tool } : {}), startedMs: performance.now() - harnessStart }; rpc.push(entry);
  try { const response = await fetch(url, init); entry.status = response.status; return response; }
  finally { entry.completedMs = performance.now() - harnessStart; entry.durationMs = entry.completedMs - entry.startedMs; }
};
const connector = new DidiMcpConnector(binding, transport), invoke = connector.invoke.bind(connector);
connector.invoke = async (...args) => { const end = begin('source-operation', { tool: args[1] }); try { return await invoke(...args); } finally { end(); } };
const store = new JobStore(join(values.output, 'tasks.sqlite'), { securityMode: 'foundation' }), members = new MemberStore(join(values.output, 'members.sqlite'));
const principal = { issuer: 'https://local-read-validation.invalid', tenant: 'isolated-verification', subject: randomUUID(), clientId: 'local-measurement', scopes: [...SCOPES, 'members:write', 'openid'] };
const owner = ownerKey(principal), program = new DidiAgentProgram(binding, { connector }); bindPersonalSourceOwner(program, owner);
const catalog = new ExecutionCatalog([program.capability()], [], [], [], [program], undefined, store.security);
const manager = new AuthorizationCoordinator(store.security, members, store, catalog); manager.start();
let worker, task, submittedAt, result;
let modelRequests = 0;
try {
  const member = members.login(principal); members.apply(member.id, { displayName: 'Isolated read-only verification', locale: 'zh-CN', timezone: 'Asia/Shanghai', consent: true }, false);
  const installationId = randomUUID(), credential = randomBytes(32).toString('base64url'), token = randomBytes(32).toString('base64url'), now = Date.now();
  members.agents.create({ registrationId: installationId, displayName: 'Read-only candidate measurement' }, credential);
  members.agents.bind(installationId, credential, principal, member.id, token, now + 600000, now, true); members.authorize(principal);
  const policy = store.security.policies, profile = catalog.securityProfiles(owner)[0], expiresAt = new Date(now + 600000).toISOString();
  if (!profile) throw new Error('The selected read source has no reviewed security profile');
  const channels = ['agent_response', 'registered_model'], markings = ['member_private', 'personal_data', 'precise_location', 'financial', 'account_private'];
  const resources = [...new Set(['ServiceRequest', ...profile.outputTypes, ...Object.keys(taskContextFields)])].map(type => ({ type,
    fields: Object.keys(policy.fields(type)).filter(field => policy.fieldPolicy(type, field) !== 'internal_only') }));
  manager.approveAgentGrant(member.id, { installationId, capabilityIds: [program.ref.id], resources, sourceBindingIds: [profile.bindingId], channels, expiresAt });
  policy.setRole({ subjectKind: 'installation', subjectId: installationId, resource: { kind: 'namespace', id: policy.model.ref.id, version: policy.model.ref.digest }, role: 'Viewer',
    executeActions: program.actionIds, invokeFunctions: policy.model.definitionSnapshot().functions.map(fn => fn.id), expiresAt }, policy.revision());
  policy.setRecipient(installationId, { classification: 'sensitive', markings, channels, expiresAt }, policy.revision());
  policy.setModelChannel('codex-native', { classification: 'sensitive', markings, expiresAt }, policy.revision());
  policy.setSource(owner, { installationId, bindingId: profile.bindingId, programId: program.ref.id, programDigest: program.configurationDigest,
    operations: program.actionIds, outputTypes: profile.outputTypes, expiresAt }, policy.revision());
  const configuration = { model: settings.EIGOS_CODEX_MODEL, reasoningEffort: settings.EIGOS_CODEX_REASONING_EFFORT ?? 'medium', serviceTier: settings.EIGOS_CODEX_SERVICE_TIER ?? 'priority' };
  const executor = new CodexExecutor(settings.EIGOS_CODEX_BIN, 120000, configuration), runStructured = executor.runStructured.bind(executor);
  executor.runStructured = async (...args) => {
    if (++modelRequests > 1) throw new Error('Candidate requested an extra model invocation');
    const end = begin('model'); try { return await runStructured(...args); } finally { end(); }
  };
  const coordinator = new Coordinator(store, new CodexReasoner(executor), catalog), tasks = new TaskService(store, { catalog });
  const actor = { ...principal, access: manager.authenticate(principal, token) };
  submittedAt = performance.now();
  task = tasks.submit(actor, { service: 'eigos.delegate', requestId: randomUUID(),
    goal: `只查询从${values.origin}到${values.destination}的${values.class}预估价，返回实际来源支持的车型、价格与查询时间。不下单、不叫车、不付款。`,
    locationContext: { city: values.city, origin: { name: values.origin, source: 'user_provided' }, destination: { name: values.destination, source: 'user_provided' } } });
  worker = new Worker(store, { coordinator, pollMs: 25, leaseMs: 30000, timeoutMs: 180000 }); worker.start();
  const deadline = performance.now() + 210000;
  let previous;
  while (performance.now() < deadline) {
    const current = store.get(owner, task.id);
    if (current.state !== previous) { console.log(JSON.stringify({ progress: current.state, elapsedMs: performance.now() - submittedAt, modelRequests })); previous = current.state; }
    if (!['submitted', 'working'].includes(current.state)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const done = store.get(owner, task.id), elapsedMs = performance.now() - submittedAt;
  const readback = tasks.get(actor, task.id);
  result = { status: done.state, accepted: done.delegation?.acceptance?.accepted === true, taskId: task.id,
    scope: 'isolated Foundation Worker; real model and real DiDi reads; no primary deployment or PA/Relay timing',
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dirtySource: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    model: configuration, ontology: store.ontology.model.ref, elapsedMs, setupMs: submittedAt - harnessStart, modelRequests,
    modelRuns: done.runs?.map(run => ({ id: run.id, purpose: run.purpose, durationMs: run.durationMs ?? run.timing?.totalMs, promptBytes: run.promptBytes,
      singleReadDecision: run.singleReadDecision, toolFreeInvocation: run.toolFreeInvocation, nativeTiming: run.nativeTiming, usage: run.usage })),
    ontologyReads: done.delegation?.ontologyReads?.map(read => ({ tool: read.tool, origin: read.origin, status: read.status, outputBytes: read.outputBytes })),
    sourceCalls: rpc.filter(value => value.method === 'tools/call').map(value => value.tool), rpc, spans,
    noOrderOrPayment: done.delegation?.agent?.plans.every(plan => plan.steps.every(step => step.effect === 'read')) === true,
    readbackState: readback.state, artifact: done.artifact, recovery: done.delegation?.recovery, error: done.error,
    feedback: done.delegation?.agent?.feedback, groundingFeedback: done.delegation?.groundingFeedback, events: done.delegation?.events };
  writeFileSync(join(values.output, 'measurement.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ status: result.status, accepted: result.accepted, elapsedMs, modelRequests, sourceCalls: result.sourceCalls, noOrderOrPayment: result.noOrderOrPayment, output: join(values.output, 'measurement.json') }));
  if (!result.accepted || result.status !== 'completed' || modelRequests !== 1 || !result.noOrderOrPayment) process.exitCode = 1;
} finally { await worker?.close(); manager.close(); members.close(); store.close(); }
