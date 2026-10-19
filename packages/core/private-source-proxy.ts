import { execFileSync } from 'node:child_process';
import type { Config } from './config.js';

/** Validate the exact private frontend; unrelated public services on other ports are untouched. */
export function validateSourceProxy(config: Config, snapshot: unknown): void {
  const origin = config.EIGOS_MEMBER_SOURCE_TAILNET_ORIGIN;
  if (!origin) return;
  const url = new URL(origin), port = url.port || '443', authority = `${url.hostname}:${port}`;
  const s = snapshot as { TCP?: Record<string, { HTTPS?: unknown }>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }>; AllowFunnel?: Record<string, unknown> } | null;
  const handlers = s?.Web?.[authority]?.Handlers, funnel = s?.AllowFunnel?.[authority];
  if (!s || s.TCP?.[port]?.HTTPS !== true || !handlers || Object.keys(handlers).length !== 1 || handlers['/']?.Proxy !== `http://127.0.0.1:${config.PORT}` || (funnel !== undefined && funnel !== false)) throw new Error('Member source requires an exact private Tailscale HTTPS proxy with Funnel disabled');
}
export function assertSourceProxy(config: Config): void {
  if (!config.EIGOS_MEMBER_SOURCE_TAILNET_ORIGIN) return;
  try { validateSourceProxy(config, JSON.parse(execFileSync('tailscale', ['serve', 'status', '--json'], { encoding: 'utf8', timeout: 5000, maxBuffer: 1048576, stdio: ['ignore', 'pipe', 'pipe'] }))); }
  catch { throw new Error('Cannot verify the private source HTTPS frontend; no service was started'); }
}
