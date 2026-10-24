import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { Config } from '../core/config.js';

const frontendSchema = z.object({
  version: z.literal(1), kind: z.literal('cloudflare-tunnel'),
  accountId: z.string().regex(/^[a-f0-9]{32}$/), tunnelId: z.uuid(),
  tunnelName: z.string().regex(/^eigos-invite-beta(?:-[a-z0-9-]{1,32})?$/), hostname: z.string().min(1).max(253),
}).strict();
export type CloudflareFrontend = z.infer<typeof frontendSchema>;

export function readCloudflareFrontend(path: string): CloudflareFrontend {
  if (!isAbsolute(path)) throw new Error('Use an absolute private Cloudflare frontend file');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 8192) {
    throw new Error('Cloudflare frontend configuration must be an owned private regular file');
  }
  return frontendSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

const emptyOptions = (value: unknown) => value === undefined
  || (!!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);

/** The DNS record is provisioned separately. Deployment must also read the
 * public HTTPS health, OAuth resource and unauthenticated denial afterwards. */
export function validateCloudflareFrontend(config: Config, input: CloudflareFrontend, snapshot: unknown): void {
  const frontend = frontendSchema.parse(input), url = new URL(config.PUBLIC_URL);
  const s = snapshot as {
    tunnel?: { id?: unknown; name?: unknown; config_src?: unknown; deleted_at?: unknown; status?: unknown; connections?: unknown[] };
    configuration?: { tunnel_id?: unknown; source?: unknown; config?: {
      ingress?: { hostname?: unknown; service?: unknown; path?: unknown; originRequest?: unknown }[];
      originRequest?: unknown; 'warp-routing'?: { enabled?: unknown };
    } };
  } | null;
  const tunnel = s?.tunnel, configuration = s?.configuration, routing = configuration?.config, rules = routing?.ingress;
  if (config.EIGOS_INVITE_BETA !== 'true' || config.HOST !== '127.0.0.1' || url.protocol !== 'https:' || url.port
    || frontend.hostname !== url.hostname || tunnel?.id !== frontend.tunnelId || tunnel.name !== frontend.tunnelName
    || tunnel.config_src !== 'cloudflare' || tunnel.deleted_at !== null || tunnel.status !== 'healthy'
    || !Array.isArray(tunnel.connections) || !tunnel.connections.length
    || configuration?.tunnel_id !== frontend.tunnelId || configuration.source !== 'cloudflare'
    || !routing || Object.keys(routing).some(key => !['ingress', 'originRequest', 'warp-routing'].includes(key))
    || !emptyOptions(routing.originRequest) || (routing['warp-routing'] && routing['warp-routing'].enabled !== false)
    || !Array.isArray(rules) || rules.length !== 2
    || rules[0]?.hostname !== frontend.hostname || rules[0].service !== `http://127.0.0.1:${config.PORT}`
    || Object.keys(rules[0]).some(key => !['hostname', 'service', 'originRequest'].includes(key)) || !emptyOptions(rules[0].originRequest)
    || rules[1]?.service !== 'http_status:404' || Object.keys(rules[1]).some(key => key !== 'service')) {
    throw new Error('Invite beta requires its exact healthy Cloudflare tunnel, hostname, loopback target and 404 fallback');
  }
}

export function assertCloudflareFrontend(config: Config, frontend: CloudflareFrontend): void {
  try {
    frontendSchema.parse(frontend);
    // Wrangler owns operator authentication. Neither the token nor its errors
    // enter the Gateway/Worker environment, command arguments or public logs.
    const auth = JSON.parse(execFileSync('wrangler', ['auth', 'token', '--json'], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 1048576, stdio: ['ignore', 'pipe', 'pipe'],
    }));
    if (typeof auth.token !== 'string' || !/^[A-Za-z0-9._~+/-]{20,4096}={0,2}$/.test(auth.token)) throw new Error('Invalid operator token');
    const base = `https://api.cloudflare.com/client/v4/accounts/${frontend.accountId}/cfd_tunnel/${frontend.tunnelId}`;
    const read = (suffix: '' | '/configurations') => {
      const response = JSON.parse(execFileSync('curl', ['--disable', '--silent', '--show-error', '--fail', '--max-time', '15', '--proto', '=https', '--config', '-', base + suffix], {
        input: `header = "Authorization: Bearer ${auth.token}"\nheader = "Accept: application/json"\n`,
        encoding: 'utf8', timeout: 20000, maxBuffer: 1048576, stdio: ['pipe', 'pipe', 'pipe'],
      }));
      if (response.success !== true) throw new Error('Cloudflare readback was not confirmed');
      return response.result;
    };
    validateCloudflareFrontend(config, frontend, { tunnel: read(''), configuration: read('/configurations') });
  } catch {
    throw new Error('Cannot verify the dedicated Cloudflare frontend; check operator login and tunnel connectivity');
  }
}
