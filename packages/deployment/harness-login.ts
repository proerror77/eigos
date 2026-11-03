import { spawn } from 'node:child_process';
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { primaryRuntime } from './primary.js';

export const CODEX_LOGIN_VERSION = 'codex-cli 0.164.0';
export interface HarnessLoginConfiguration { version: 1; codexBin: string; codexHome: string; credentialFile: string }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function privateJson(path: string): Record<string, unknown> {
  if (!isAbsolute(path)) throw new Error('Login files require absolute private paths');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 65536) throw new Error('Use an owned private login file');
    try { return object(JSON.parse(readFileSync(fd, 'utf8'))); }
    catch { throw new Error('Invalid private login JSON'); }
  } finally { closeSync(fd); }
}
function privateDirectory(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new Error('Use an owned private login directory');
  return realpathSync(path);
}
export function readHarnessLogin(path: string, runtime = primaryRuntime()): HarnessLoginConfiguration {
  const value = privateJson(path);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(['codexBin', 'codexHome', 'credentialFile', 'version']) || value.version !== 1
    || ![value.codexBin, value.codexHome, value.credentialFile].every(v => typeof v === 'string' && isAbsolute(v) && !/[\u0000-\u001f\u007f]/.test(v))) throw new Error('Invalid managed Harness login configuration');
  const config = value as unknown as HarnessLoginConfiguration, root = privateDirectory(runtime);
  for (const path of [privateDirectory(config.codexHome), privateDirectory(dirname(config.credentialFile))]) {
    const within = relative(root, path); if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('The cloud login must be isolated inside the owned primary runtime');
  }
  if (resolve(config.credentialFile) === join(resolve(config.codexHome), 'auth.json')) throw new Error('Harness must never consume its refresh-owner file');
  if (existsSync(config.credentialFile)) privateJson(config.credentialFile);
  return config;
}
function access(config: HarnessLoginConfiguration, now: number) {
  const auth = privateJson(join(config.codexHome, 'auth.json')), tokens = object(auth.tokens), token = tokens.access_token;
  if (auth.auth_mode !== 'chatgpt' || typeof token !== 'string' || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) throw new Error('Complete a separate managed ChatGPT login on this host');
  let exp: unknown;
  try { exp = object(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))).exp; } catch { /* Rejected below. */ }
  if (typeof exp !== 'number' || !Number.isFinite(exp)) throw new Error('Managed ChatGPT access has no valid expiry');
  return { token, expires: exp * 1000, remaining: exp * 1000 - now };
}

/** Only account/read is used: native Codex owns OAuth refresh, never inference,
 * tools or tasks. Call under the single managed systemd/flock refresh owner. */
async function refresh(config: HarnessLoginConfiguration, timeoutMs: number): Promise<void> {
  const child = spawn(config.codexBin, ['app-server', '--stdio'], { cwd: config.codexHome, detached: process.platform !== 'win32',
    env: { HOME: homedir(), CODEX_HOME: config.codexHome, PATH: [dirname(config.codexBin), dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'), LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
  let seq = 0, bytes = 0, buffer = '', failure: Error | undefined, exited = false;
  const decoder = new StringDecoder('utf8');
  const stop = (signal: NodeJS.Signals) => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already gone. */ } };
  const fail = () => { failure ??= new Error('Native cloud login refresh failed'); for (const entry of pending.values()) entry.reject(failure); pending.clear(); stop('SIGKILL'); };
  const closed = new Promise<void>(resolve => child.once('close', () => { exited = true; if (pending.size) fail(); resolve(); }));
  child.once('error', fail); child.stdin.on('error', fail);
  child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 262144) fail(); });
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length; if (bytes > 262144) { fail(); return; }
    buffer += decoder.write(chunk); let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
      let packet: Record<string, unknown>; try { packet = object(JSON.parse(line)); } catch { fail(); return; }
      if (typeof packet.id === 'number') {
        const entry = pending.get(packet.id); if (!entry || packet.error || typeof packet.method === 'string') { fail(); return; }
        pending.delete(packet.id); entry.resolve(object(packet.result));
      }
    }
  });
  const request = (method: string, params: object) => new Promise<Record<string, unknown>>((resolve, reject) => {
    if (failure || exited) { reject(failure ?? new Error('Native cloud login is unavailable')); return; }
    const id = ++seq; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const timer = setTimeout(fail, timeoutMs);
  try {
    await request('initialize', { clientInfo: { name: 'eigos-cloud-login', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    const result = await request('account/read', { refreshToken: true });
    if (object(result.account).type !== 'chatgpt') throw new Error('Cloud refresh requires its own managed ChatGPT login');
    if (failure) throw failure;
  } finally {
    clearTimeout(timer); child.stdin.end(); stop('SIGTERM');
    const kill = setTimeout(() => stop('SIGKILL'), 2000);
    try { await closed; } finally { clearTimeout(kill); }
  }
}

export async function refreshHarnessLogin(config: HarnessLoginConfiguration, { force = false, now = Date.now, timeoutMs = 45000 } = {}) {
  privateDirectory(config.codexHome); privateDirectory(dirname(config.credentialFile));
  if (existsSync(config.credentialFile)) privateJson(config.credentialFile);
  let current = access(config, now()), refreshed = false;
  if (force || current.remaining <= 10 * 60000) { await refresh(config, timeoutMs); current = access(config, now()); refreshed = true; }
  if (current.remaining <= 90000) throw new Error('Cloud login did not produce current access');
  if (existsSync(config.credentialFile)) privateJson(config.credentialFile);
  const temporary = config.credentialFile + '.next-' + randomUUID();
  try {
    writeFileSync(temporary, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: current.token } }) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, config.credentialFile);
  } finally { rmSync(temporary, { force: true }); }
  return { refreshed, expiresAt: new Date(current.expires).toISOString(), credentialFile: config.credentialFile };
}
