import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const queries = {
  'app-info': ['app:read', 'apprelease.queryApplicationInfo'],
  'app-detail': ['app:read', 'apprelease.queryApplicationDetail'],
  spaces: ['space:read', 'space-query-service.query-space-list'],
  abilities: ['skill:all', 'ability-query-mcp.pageQueryMcpAbility'],
  templates: ['skill:all', 'skill-template-mcp.querySelectableTemplates'],
  template: ['skill:all', 'skill-template-mcp.queryTemplateDetail'],
  whitelist: ['skill:all', 'skill-template-mcp.checkTemplateWhitelist'],
  'my-skill': ['skill:all', 'ability-query-mcp.queryMySkill'],
};
const allowedScopes = new Set(['app:read', 'skill:all', 'space:read']);

async function invoke(args) {
  let stdout;
  try {
    ({ stdout } = await exec('alipay-cli', [...args, '--json'], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }));
  } catch (error) {
    if (error.code === 'ENOENT') return { success: false, error: { code: 'CLI_NOT_INSTALLED' } };
    stdout = error.stdout;
    if (!stdout) return { success: false, error: { code: 'CLI_EXECUTION_FAILED' } };
  }
  try { return JSON.parse(stdout); }
  catch { return { success: false, error: { code: 'CLI_INVALID_JSON' } }; }
}

function handoff(result, complete) {
  const data = result.data ?? {};
  if (!result.success) return { status: 'failed', error: result.error };
  if (!data.verification_url && data.status !== 'pending') return { status: 'failed', reason: 'AUTHORIZATION_HANDOFF_UNAVAILABLE' };
  return {
    status: 'needs_user', reason: 'ALIPAY_AUTHORIZATION', complete,
    verification_url: data.verification_url,
    verification_code: data.verification_code,
    expires_in: data.expires_in,
    interval: data.interval ?? 5,
    action: '请在支付宝完成扫码授权；随后原命令追加 --complete ' + complete + ' 继续。',
  };
}

function businessResult(result) {
  if (result.success === false || result.isError) return { status: 'failed', result };
  const responses = [];
  for (const item of result.content ?? []) {
    if (item.type !== 'text') continue;
    try { responses.push(JSON.parse(item.text)); }
    catch { return { status: 'unverified', reason: 'NON_JSON_BUSINESS_RESULT', result }; }
  }
  if (!responses.length) responses.push(result);
  if (responses.some(r => r.success === false || r.isError || r.error || r.errorContext || (r.resultCode && r.resultCode !== 'SUCCESS'))) {
    return { status: 'failed', result };
  }
  if (!responses.every(r => r.success === true || r.resultCode === 'SUCCESS')) {
    return { status: 'unverified', reason: 'NO_BUSINESS_SUCCESS_SIGNAL', result };
  }
  return { status: 'completed', result };
}

/** Only known read operations are executable here. Platform writes use the documented native CLI workflow. */
export async function run(args, call = invoke) {
  const [operation, ...rest] = args;
  if (!operation || operation === 'help' || operation === '--help') {
    return { status: 'help', usage: 'node scripts/alipay-platform.mjs ensure [--scopes app:read,skill:all,space:read] | <query> --data <JSON> [--complete login|grant]', queries: Object.keys(queries) };
  }
  if (operation !== 'ensure' && !Object.hasOwn(queries, operation)) throw new Error('Unknown operation; use help. Writes and orders are not supported by this helper.');
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!['--scopes', '--data', '--complete'].includes(key) || rest[i + 1] === undefined || options[key] !== undefined) throw new Error('Invalid or duplicate option.');
    options[key] = rest[i + 1];
  }
  if (options['--complete'] && !['login', 'grant'].includes(options['--complete'])) throw new Error('Complete must be login or grant.');
  if (operation !== 'ensure' && options['--scopes']) throw new Error('Query scopes are selected automatically.');
  if (operation === 'ensure' && options['--data']) throw new Error('Ensure does not accept query data.');
  const scopes = operation === 'ensure' ? (options['--scopes'] ?? 'app:read').split(',') : [queries[operation][0]];
  if (!scopes.length || scopes.some(s => !allowedScopes.has(s))) throw new Error('Unsupported scope; see the workflow for other platform operations.');
  const scope = [...new Set(scopes)].join(',');
  // Validate parameters before any login or permission change.
  const data = operation === 'ensure' ? undefined : JSON.stringify(JSON.parse(options['--data'] ?? '{"request":{}}'));
  const version = await call(['version']);
  if (version.success !== true) return { status: 'failed', error: version.error };

  if (options['--complete']) {
    const kind = options['--complete'];
    const result = await call(['auth', kind, ...(kind === 'grant' ? ['--scope', scope] : []), '--complete']);
    if (result.data?.status === 'pending') return handoff(result, kind);
    if (!result.success || !['logged_in', 'already_logged_in'].includes(result.data?.status)) return { status: 'failed', reason: 'AUTHORIZATION_INCOMPLETE', error: result.error };
  }
  let status = await call(['auth', 'status']);
  if (status.success !== true) return { status: 'failed', error: status.error };
  if (!status.data?.logged_in || (status.data.expires_at && Date.parse(status.data.expires_at) <= Date.now())) {
    // Refresh once before asking the user to log in again. CLI owns all credentials.
    await call(['auth', 'refresh']);
    status = await call(['auth', 'status']);
    if (!status.success) return { status: 'failed', error: status.error };
    if (!status.data?.logged_in || (status.data.expires_at && Date.parse(status.data.expires_at) <= Date.now())) {
      const result = await call(['auth', 'login', '--non-interactive', '--open-browser=false', '--scope', scope]);
      if (result.data?.status !== 'already_logged_in') return handoff(result, 'login');
      status = await call(['auth', 'status']);
      if (!status.success || !status.data?.logged_in) return { status: 'failed', reason: 'SESSION_NOT_AVAILABLE' };
    }
  }
  const granted = new Set((status.data.scope ?? '').split(/[\s,]+/));
  const missing = scopes.filter(s => !granted.has(s));
  if (missing.length) {
    const result = await call(['auth', 'grant', '--scope', scope, '--non-interactive']);
    return handoff(result, 'grant');
  }
  if (operation === 'ensure') return { status: 'ready', scope: status.data.scope, expires_at: status.data.expires_at };
  return businessResult(await call(['mcp', 'call', queries[operation][1], '-d', data]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await run(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = ['ready', 'completed', 'help'].includes(result.status) ? 0 : result.status === 'needs_user' ? 2 : 1;
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', reason: error instanceof SyntaxError ? 'INVALID_JSON' : error.message }));
    process.exitCode = 1;
  }
}
