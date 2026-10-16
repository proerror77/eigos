// Explicit live probe: real provider authorization and an actual Codex Personal Agent. Never run by npm test.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import * as oidc from 'openid-client';
import { createRemoteJWKSet } from 'jose';
import { jwtVerifier } from '../apps/gateway/auth.js';
import { readTenantClaim } from '../packages/core/identity-claims.js';
import { ownerKey, SCOPES } from '../packages/core/domain.js';
import { JobStore } from '../packages/core/store.js';
import { MemberStore } from '../packages/members/store.js';
import { z } from 'zod';

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`Configure ${name} in the private Agent environment`); return value; }
const base = required('PUBLIC_URL'), issuer = required('OAUTH_ISSUER'), audience = required('OAUTH_AUDIENCE');
assert.equal(new URL(base).protocol, 'https:'); assert.equal(new URL(issuer).protocol, 'https:');
const callback = new URL(required('EIGOS_AGENT_CALLBACK_URL'));
assert.equal(callback.hostname, '127.0.0.1'); assert.equal(callback.protocol, 'http:'); assert.equal(callback.pathname, '/callback');
assert(callback.port && !callback.search && !callback.hash && !callback.username && !callback.password);
const clientId = required('EIGOS_AGENT_CLIENT_ID'), tenantClaim = process.env.OAUTH_TENANT_CLAIM ?? 'tenant_id';
const database = required('DATABASE_PATH'), membershipDatabase = required('MEMBERSHIP_DATABASE_PATH');
assert(existsSync(database) && existsSync(membershipDatabase), 'Start the isolated Gateway and complete member registration first');
const evidence = resolve(required('EIGOS_OAUTH_EVIDENCE_DIR'), new Date().toISOString().replaceAll(':', '-'));
const handoff = resolve(required('EIGOS_OAUTH_HANDOFF_PATH'));
mkdirSync(evidence, { recursive: true, mode: 0o700 }); mkdirSync(dirname(handoff), { recursive: true, mode: 0o700 });
const save = (name: string, value: unknown) => writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const update = (value: object) => writeFileSync(handoff, JSON.stringify({ ...value, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const startedAt = new Date().toISOString();
const metadataResponse = await fetch(base + '/.well-known/oauth-protected-resource');
assert(metadataResponse.ok); const metadata = await metadataResponse.json();
assert.equal(metadata.resource, audience); assert.deepEqual(metadata.authorization_servers, [issuer]);
const config = await oidc.discovery(new URL(issuer), clientId, undefined, oidc.None(), { timeout: 10 });
oidc.enableNonRepudiationChecks(config);
const verifier = oidc.randomPKCECodeVerifier(), state = oidc.randomState(), nonce = oidc.randomNonce();
const authorizationUrl = oidc.buildAuthorizationUrl(config, {
  redirect_uri: callback.href, scope: ['openid', ...SCOPES].join(' '), state, nonce,
  code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
  // Deliberate Auth0 extension for this pre-registered client; not a universal client-registration compatibility claim.
  audience,
});
const server = createServer();
let consumed = false;
const authorization = new Promise<Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>>((resolveGrant, rejectGrant) => {
  server.on('request', (req, res) => {
    const url = new URL(req.url!, callback);
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.method !== 'GET' || url.origin !== callback.origin || url.pathname !== callback.pathname || consumed) { res.writeHead(404); res.end(); return; }
    consumed = true;
    void oidc.authorizationCodeGrant(config, url, { pkceCodeVerifier: verifier, expectedState: state, expectedNonce: nonce, idTokenExpected: true }).then(tokens => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('EIGOS 授权已完成，可以回到任务查看结果。'); resolveGrant(tokens);
    }, () => { res.writeHead(400); res.end('Authorization failed; return to the EIGOS task.'); rejectGrant(new Error('Provider authorization did not complete')); });
  });
});
void authorization.catch(() => {});
server.listen(Number(callback.port), '127.0.0.1'); await once(server, 'listening');
update({ stage: 'awaiting_user_authorization', authorizationUrl: authorizationUrl.href, memberUrl: base + '/members' });
console.log('Waiting for real provider authorization. Browser handoff:', handoff);
let token = '';
const timeout = setTimeout(() => { server.closeAllConnections(); server.close(); }, 600000);
try {
  const tokens = await Promise.race([authorization, new Promise<never>((_, reject) => server.once('close', () => reject(new Error('Authorization callback deadline or shutdown'))))]);
  clearTimeout(timeout); server.closeAllConnections(); await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  token = tokens.access_token;
  const verify = jwtVerifier(issuer, audience, createRemoteJWKSet(new URL(required('OAUTH_JWKS_URL'))), tenantClaim);
  const principal = await verify(token), claims = tokens.claims()!;
  assert.equal(principal.subject, claims.sub); assert.equal(principal.issuer, claims.iss); assert.equal(principal.tenant, readTenantClaim(claims, tenantClaim));
  assert.equal(principal.clientId, clientId); assert(SCOPES.every(scope => principal.scopes.includes(scope)));
  const members = new MemberStore(membershipDatabase);
  let memberId: string;
  try {
    const member = members.find(principal);
    assert(member && member.status === 'active', 'Complete member registration with this same identity before invoking the Agent');
    memberId = member.id;
  } finally { members.close(); }
  update({ stage: 'authorized_running_agent', memberUrl: base + '/members' });
  const marker = `eigos-auth0-${randomUUID()}`;
  const goal = `[${marker}] 请根据以下已提供信息，生成一份中文会议议程：6 人参加、总时长 30 分钟、主题是项目需求澄清；包含三个议题、每个议题的分钟数与预期产出。只生成文档，不执行任何外部业务。`;
  save('request.json', { marker, goal, startedAt });
  const prompt = `你是用户的 Personal Agent，真实调用已授权的 EIGOS 服务。只使用提供的 eigos MCP 工具。先发现服务；确认 agent.execute 已启用后，创建且只创建一个任务，goal 原文为：${goal}\n请求 ID 保持稳定，查询只能用实际返回的 taskId。用 get_task 读到 completed、failed 或需要用户输入的状态；working 时继续查询，最多 30 次。若失败或超时，报告实际状态，不创建替代任务。若补问，仅能依据以上已给信息答复，不编造信息。完成后再次读取交付物，输出真实 taskId 和完整 Markdown 议程。`;
  const temp = mkdtempSync(join(tmpdir(), 'eigos-member-agent-'));
  const events: { type: string; item?: { type: string; server?: string; tool?: string; status?: string; result?: unknown }; thread_id?: string }[] = [];
  try {
    const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--approve-for-me',
      '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"',
      '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'plugins', '--disable', 'hooks', '--disable', 'memories',
      '--disable', 'multi_agent', '--disable', 'multi_agent_v2', '--disable', 'computer_use', '--disable', 'browser_use',
      '--disable', 'in_app_browser', '--disable', 'image_generation', '--disable', 'code_mode',
      '-c', `mcp_servers.eigos.url=${JSON.stringify(base + '/mcp')}`,
      '-c', 'mcp_servers.eigos.bearer_token_env_var="EIGOS_MEMBER_ACCESS_TOKEN"',
      '--output-last-message', join(evidence, 'agent-final.md'), '--json', '-'];
    await new Promise<void>((resolveRun, rejectRun) => {
      const env: NodeJS.ProcessEnv = {};
      for (const key of ['PATH','HOME','USER','TMPDIR','LANG','CODEX_HOME','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY','SSL_CERT_FILE']) if (process.env[key]) env[key] = process.env[key];
      env.NO_PROXY = [env.NO_PROXY, new URL(base).hostname, '127.0.0.1', 'localhost'].filter(Boolean).join(',');
      env.EIGOS_MEMBER_ACCESS_TOKEN = token;
      const child = spawn(process.env.EIGOS_CODEX_BIN ?? 'codex', args, { cwd: temp, env, stdio: ['pipe','pipe','pipe'], detached: process.platform !== 'win32' });
      let buffer = '', total = 0;
      const kill = () => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} };
      const deadline = setTimeout(kill, 300000);
      child.stdout.on('data', (chunk: Buffer) => {
        total += chunk.length; if (total > 2000000) { kill(); return; }
        buffer += chunk.toString(); const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
        for (const line of lines) {
          try {
            const event = JSON.parse(line.replaceAll(token, '[redacted]'));
            if (['thread.started','turn.completed','turn.failed','error'].includes(event.type) || (event.type === 'item.completed' && ['mcp_tool_call','agent_message'].includes(event.item?.type))) events.push(event);
            if (event.item?.type === 'mcp_tool_call' && event.type === 'item.completed') console.log('Agent tool:', event.item.tool, event.item.status);
          } catch {}
        }
      });
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => {}); child.on('error', rejectRun);
      child.on('close', code => { clearTimeout(deadline); code === 0 ? resolveRun() : rejectRun(new Error(`Personal Agent exited with status ${code}; inspect the original task before retrying`)); });
      child.stdin.end(prompt);
    });
    assert(events.some(event => event.type === 'turn.completed'), 'The actual Personal Agent did not complete its turn');
    const calls = events.filter(event => event.item?.type === 'mcp_tool_call' && event.item.server === 'eigos');
    assert(calls.some(event => event.item?.tool === 'submit_task') && calls.some(event => event.item?.tool === 'get_task'));
    const store = new JobStore(database);
    let job;
    try {
      const matching = store.list(ownerKey(principal), { limit: 100, offset: 0 }).jobs.filter(job => job.goal === goal);
      assert.equal(matching.length, 1, 'Expected exactly one model-created task with this run marker'); job = matching[0]!;
    } finally { store.close(); }
    assert.equal(job.state, 'completed'); assert.equal(job.service, 'agent.execute'); assert(job.artifact?.data.markdown);
    assert(job.runs?.length && job.runs.every(run => run.runtime === 'codex-exec' && run.threadId));
    const response = await fetch(base + '/a2a', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'A2A-Version': '1.0', 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'GetTask', params: { id: job.id } }) });
    assert(response.ok); const a2a = (await response.json()).result;
    assert.equal(a2a.status.state, 'TASK_STATE_COMPLETED');
    assert.equal(a2a.artifacts[0].parts[0].text, job.artifact.data.markdown);
    const readbackSchema = z.object({ id: z.string(), state: z.literal('completed'), artifact: z.object({ data: z.object({ markdown: z.string() }) }) });
    const readbacks = calls.filter(event => event.item?.tool === 'get_task').map(event => {
      const result = event.item?.result as { structured_content?: { result?: unknown }; structuredContent?: { result?: unknown } } | undefined;
      return readbackSchema.safeParse(result?.structured_content?.result ?? result?.structuredContent?.result);
    });
    assert(readbacks.some(value => value.success && value.data.id === job.id && value.data.artifact.data.markdown === job.artifact!.data.markdown), 'The Personal Agent did not read the identical completed artifact itself');
    const callerThread = events.find(event => event.type === 'thread.started')?.thread_id;
    assert(callerThread && job.runs.every(run => run.threadId !== callerThread), 'Caller and Worker must be separate model runtimes');
    const final = readFileSync(join(evidence, 'agent-final.md'), 'utf8');
    assert(!final.includes(token), 'A credential appeared in the model output');
    save('agent-events.json', events); writeFileSync(join(evidence, 'deliverable.md'), job.artifact.data.markdown, { mode: 0o600 });
    const verification = {
      startedAt, completedAt: new Date().toISOString(), provider: 'Auth0', authorization: 'real authorization-code + S256 PKCE',
      client: 'actual Codex Personal Agent over remote HTTP MCP', serverAgent: 'actual Codex executor',
      memberHash: hash(memberId), subjectHash: hash(JSON.stringify([principal.issuer, principal.tenant, principal.subject])),
      scopes: principal.scopes.filter(scope => SCOPES.includes(scope as typeof SCOPES[number])), toolCalls: calls.length,
      taskId: job.id, state: job.state, workerModelCalls: job.runs.length, artifactSha256: hash(job.artifact.data.markdown),
      mcpAgentReadback: true, a2aReadback: true, independentDatabaseReadback: true,
      boundary: 'Private HTTPS integration on this Mac; document generation only; no public production release or commerce execution',
    };
    save('verification.json', verification); update({ stage: 'completed', evidenceDirectory: evidence, taskId: job.id });
    console.log('Real member → OAuth → Personal Agent → EIGOS Agent → independent readback verified:', job.id);
  } finally {
    save('agent-events.json', events);
    const finalPath = join(evidence, 'agent-final.md');
    if (existsSync(finalPath)) writeFileSync(finalPath, readFileSync(finalPath, 'utf8').replaceAll(token, '[redacted]'), { mode: 0o600 });
    rmSync(temp, { recursive: true, force: true });
  }
} catch {
  update({ stage: 'not_completed', evidenceDirectory: evidence, memberUrl: base + '/members' });
  throw new Error('Real member/Agent verification did not complete. Inspect the private handoff and original task; do not silently retry creation.');
} finally { clearTimeout(timeout); token = ''; server.closeAllConnections(); if (server.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose())); }
