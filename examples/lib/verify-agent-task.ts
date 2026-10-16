import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRemoteJWKSet } from 'jose';
import { z } from 'zod';
import { jwtVerifier } from '../../apps/gateway/auth.js';
import { MemberStore } from '../../packages/members/store.js';
import { JobStore } from '../../packages/core/store.js';
import { ownerKey, SCOPES } from '../../packages/core/domain.js';

export async function verifyAgentTask(options: { base: string; issuer: string; audience: string; clientId: string; tenantClaim: string; jwksUrl: string; token: string; database: string; membershipDatabase: string; evidenceDirectory: string; authorization: string }) {
  const { base, issuer, audience, clientId, tenantClaim, token, database, membershipDatabase } = options;
  const evidence = resolve(options.evidenceDirectory); mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const save = (name: string, value: unknown) => writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const startedAt = new Date().toISOString();
  const principal = await jwtVerifier(issuer, audience, createRemoteJWKSet(new URL(options.jwksUrl)), tenantClaim)(token);
  assert.equal(principal.clientId, clientId); assert(SCOPES.every(scope => principal.scopes.includes(scope)));
  const members = new MemberStore(membershipDatabase);
  let memberId: string;
  try {
    const member = members.find(principal);
    assert(member && member.status === 'active', 'Complete member registration with this same identity before invoking the Agent');
    memberId = member.id;
  } finally { members.close(); }
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
      startedAt, completedAt: new Date().toISOString(), provider: 'Auth0', authorization: options.authorization,
      client: 'actual Codex Personal Agent over remote HTTP MCP', serverAgent: 'actual Codex executor',
      memberHash: hash(memberId), subjectHash: hash(JSON.stringify([principal.issuer, principal.tenant, principal.subject])),
      scopes: principal.scopes.filter(scope => SCOPES.includes(scope as typeof SCOPES[number])), toolCalls: calls.length,
      taskId: job.id, state: job.state, workerModelCalls: job.runs.length, artifactSha256: hash(job.artifact.data.markdown),
      mcpAgentReadback: true, a2aReadback: true, independentDatabaseReadback: true,
      boundary: 'Private HTTPS integration on this Mac; document generation only; no public production release or commerce execution',
    };
    save('verification.json', verification);
    console.log('Real member → OAuth → Personal Agent → EIGOS Agent → independent readback verified:', job.id);
    return verification;
  } finally {
    save('agent-events.json', events);
    const finalPath = join(evidence, 'agent-final.md');
    if (existsSync(finalPath)) writeFileSync(finalPath, readFileSync(finalPath, 'utf8').replaceAll(token, '[redacted]'), { mode: 0o600 });
    rmSync(temp, { recursive: true, force: true });
  }
}
