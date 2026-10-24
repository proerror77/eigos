import { execFileSync } from 'node:child_process';
import type { Config } from '../core/config.js';

/** Check only this deployment's listener. Existing private/public ports belong
 * to their current owners and are never rewritten by this check. */
export function validateInviteBetaProxy(config: Config, snapshot: unknown): void {
  const url = new URL(config.PUBLIC_URL), port = url.port || '443', authority = `${url.hostname}:${port}`;
  const s = snapshot as { TCP?: Record<string, { HTTPS?: unknown }>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }>; AllowFunnel?: Record<string, unknown> } | null;
  const handlers = s?.Web?.[authority]?.Handlers;
  if (config.EIGOS_INVITE_BETA !== 'true' || config.HOST !== '127.0.0.1' || !url.hostname.endsWith('.ts.net')
    || !s || s.TCP?.[port]?.HTTPS !== true || s.AllowFunnel?.[authority] !== true || !handlers || Object.keys(handlers).length !== 1
    || handlers['/']?.Proxy !== `http://127.0.0.1:${config.PORT}`) throw new Error('Invite beta requires its exact dedicated HTTPS Funnel and loopback target');
}

export function assertInviteBetaProxy(config: Config): void {
  try { validateInviteBetaProxy(config, JSON.parse(execFileSync('tailscale', ['serve', 'status', '--json'], { encoding: 'utf8', timeout: 5000, maxBuffer: 1048576, stdio: ['ignore', 'pipe', 'pipe'] }))); }
  catch { throw new Error('Cannot verify the invite beta HTTPS frontend; no service was started'); }
}
