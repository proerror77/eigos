import { lookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import { InvalidInput, PermissionDenied, SourceReadFailure, digest } from '../core/identity.js';
import { ontologyName } from '../ontology/schema.js';
import { ComponentSourceSecrets } from './component-source-secrets.js';
import { ComponentOAuthGrants, SourceOAuthReauthorization, SourceOAuthRejection } from './component-source-oauth.js';
import type { Database } from './database.js';

const method = z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const httpsUrl = z.url().transform(value => new URL(value)).refine(url =>
  url.protocol === 'https:' && !url.username && !url.password && !url.hash, 'An HTTPS URL without credentials or fragment is required');
const secretName = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const oauthClient = {
  tokenUrl: httpsUrl.refine(url => !url.search, 'The token URL must have no query'),
  clientId: z.string().min(1).max(200),
  clientSecret: secretName,
};
const oauthSchema = z.discriminatedUnion('grant', [
  z.strictObject({ ...oauthClient, grant: z.literal('client_credentials'), scope: z.string().min(1).max(1000).optional() }),
  z.strictObject({ ...oauthClient, grant: z.literal('refresh_token'), refreshTokenSecret: secretName }),
]);
type OAuth = z.infer<typeof oauthSchema>;
const tokenResponse = z.object({
  access_token: z.string().min(1).max(32768).regex(/^[^\r\n]+$/),
  token_type: z.string().refine(value => value.toLowerCase() === 'bearer'),
  expires_in: z.number().int().positive().max(86400).optional(),
  refresh_token: z.string().min(1).max(64 * 1024).optional(),
});
const knownRejections = new Set(['invalid_request', 'invalid_client', 'unauthorized_client', 'unsupported_grant_type',
  'invalid_scope', 'temporarily_unavailable', 'server_error']);
const connectionSchema = z.strictObject({
  baseUrl: httpsUrl.refine(url => !url.search && url.pathname.endsWith('/'), 'The base must end with / and have no query'),
  methods: z.array(method).min(1).max(6),
  networks: z.array(z.string().min(3).max(90)).max(32).optional(),
  bearerSecret: secretName.optional(),
  oauth: oauthSchema.optional(),
}).refine(value => !value.bearerSecret || !value.oauth, 'Configure one Source credential mechanism');
export const componentHttpConnections = z.record(ontologyName, connectionSchema);
type Method = z.infer<typeof method>;
type Connection = z.infer<typeof connectionSchema>;
const outboundRequest = z.strictObject({
  path: z.string().min(1).max(4096),
  method: method.default('GET'),
  body: z.string().max(256 * 1024).optional(),
  contentType: z.enum(['application/json', 'text/plain']).default('application/json'),
});
const responseLimit = 1 << 20;
type OutboundContext = {
  mode: 'read' | 'effect';
  signal: AbortSignal;
  /** Revalidates the current source permission and, for effects, the persisted dispatch authorization. */
  authorize: (source: string, method: Method) => Promise<void>;
  secret: (name: string) => Promise<string>;
};
type RequestOptions = {
  method: Method; body?: string; headers: Record<string, string>; networks?: string[]; signal: AbortSignal;
};
type ReadResponse = { status: number; contentType: string | null; body: string };
type Transport = (url: URL, options: RequestOptions) => Promise<ReadResponse>;
type TimedToken = { value: string; validUntil: number };
type EgressRecord = { source: string; outcome: 'returned' | 'denied' | 'failed'; status?: number };

function networkList(networks: readonly string[]) {
  const rules = new BlockList();
  for (const configured of networks) {
    const [address, length, extra] = configured.split('/');
    const family = isIP(address ?? ''), prefix = Number(length);
    if (!family || extra !== undefined || !length || !/^\d+$/.test(length) || prefix > (family === 4 ? 32 : 128))
      throw new InvalidInput('Invalid Source network');
    rules.addSubnet(address!, prefix, family === 4 ? 'ipv4' : 'ipv6');
  }
  return rules;
}

const restricted = networkList([
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
  '224.0.0.0/3', '2001:db8::/32', '2002::/16',
]);
const globalV6 = networkList(['2000::/3']);
const reservedMetadata = networkList(['169.254.0.0/16', '100.100.100.200/32', 'fd00:ec2::254/128']);

function allowedAddress(address: string, family: number, networks?: BlockList) {
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (reservedMetadata.check(address, type)) return false;
  if (networks) return networks.check(address, type);
  return !restricted.check(address, type) && (family === 4 || globalV6.check(address, 'ipv6'));
}

class SourceRequestNotDispatched extends SourceReadFailure {
  constructor() { super('Source connection could not be resolved'); }
}

async function httpsTransport(url: URL, options: RequestOptions): Promise<ReadResponse> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(hostname);
  const addresses = literal ? [{ address: hostname, family: literal }]
    : await lookup(hostname, { all: true }).catch(() => { throw new SourceRequestNotDispatched(); });
  if (options.signal.aborted) throw new SourceRequestNotDispatched();
  const networks = options.networks && networkList(options.networks);
  if (!addresses.length || addresses.some(({ address, family }) => !allowedAddress(address, family, networks)))
    throw new PermissionDenied('Source resolved outside its egress network');
  const pinned = addresses[0]!;
  return await new Promise<ReadResponse>((resolve, reject) => {
    // Resolve once, then connect to the checked address. Retain the HTTPS hostname for certificate checks.
    const outgoing = request(url, {
      method: options.method, headers: options.headers, signal: options.signal, agent: false, family: pinned.family,
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
    }, response => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('error', reject);
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > responseLimit) response.destroy(new SourceReadFailure('Source response is too large'));
        else chunks.push(chunk);
      });
      response.once('end', () => resolve({
        status: response.statusCode ?? 502,
        contentType: response.headers['content-type'] ?? null,
        body: Buffer.concat(chunks).toString(),
      }));
    });
    outgoing.once('error', reject);
    outgoing.end(options.body);
  });
}

function targetUrl(connection: Connection, path: string) {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\#\u0000-\u001f]/u.test(path))
    throw new PermissionDenied('Source request must use a relative path within its base');
  const target = new URL(path, connection.baseUrl);
  if (target.origin !== connection.baseUrl.origin || !target.pathname.startsWith(connection.baseUrl.pathname))
    throw new PermissionDenied('Source request is outside its allowed base');
  return target;
}

/** A Function receives access to one declared Source. The runtime owns authorization, connection details and credentials. */
export class ComponentSourceEgress {
  private readonly connections: z.infer<typeof componentHttpConnections>;
  private readonly tokens = new Map<string, Promise<TimedToken>>();

  constructor(configuration: unknown, private readonly transport: Transport = httpsTransport,
    private readonly audit: (entry: EgressRecord) => void = entry => { console.info(JSON.stringify({ event: 'function_source_egress', ...entry })); },
    private readonly grants?: ComponentOAuthGrants) {
    this.connections = componentHttpConnections.parse(configuration);
    for (const connection of Object.values(this.connections)) {
      if (connection.networks) networkList(connection.networks);
      if (connection.oauth?.grant === 'refresh_token' && !this.grants)
        throw new Error('Configure encrypted Source OAuth grant storage');
    }
  }

  binding(source: string) {
    const connection = Object.hasOwn(this.connections, source) ? this.connections[source] : undefined;
    if (!connection) throw new PermissionDenied('The declared Source has no HTTP connection');
    const { oauth, ...transport } = connection;
    return digest({ ...transport, baseUrl: connection.baseUrl.href, ...(oauth ? { oauth: { ...oauth, tokenUrl: oauth.tokenUrl.href } } : {}) });
  }

  private async clientToken(source: string, oauth: Extract<OAuth, { grant: 'client_credentials' }>, context: OutboundContext,
    networks: string[] | undefined): Promise<TimedToken> {
    const current = this.tokens.get(source);
    if (current) {
      const known = await current;
      if (known.validUntil > Date.now()) return known;
    }
    // Deduplicate refreshes within a process. A canceled Function must not cancel another caller's pending token exchange.
    const replacement = this.tokens.get(source);
    if (replacement && replacement !== current) return replacement;
    const refresh = context.secret(oauth.clientSecret).then(credential => this.exchangeToken(oauth, credential, networks));
    this.tokens.set(source, refresh);
    try {
      return await refresh;
    } catch (error) {
      if (this.tokens.get(source) === refresh) this.tokens.delete(source);
      throw error;
    }
  }

  private async refreshToken(source: string, method: Method, oauth: Extract<OAuth, { grant: 'refresh_token' }>,
    context: OutboundContext, networks: string[] | undefined, signal: AbortSignal) {
    // Alias or egress policy changes may reuse the same provider grant. A new seed name creates a new grant.
    const identity = digest({ endpoint: oauth.tokenUrl.href, client: oauth.clientId, secret: oauth.refreshTokenSecret });
    return this.grants!.token(identity, () => context.secret(oauth.refreshTokenSecret), async refreshToken => {
      let credential: string;
      try {
        await context.authorize(source, method);
        signal.throwIfAborted();
        credential = await context.secret(oauth.clientSecret);
        signal.throwIfAborted();
      } catch (error) { throw new SourceOAuthRejection(error); }
      const result = await this.exchangeToken(oauth, credential, networks, refreshToken);
      return { accessToken: result.value, validUntil: result.validUntil, refreshToken: result.refreshToken ?? refreshToken };
    }, signal);
  }

  private async exchangeToken(oauth: OAuth, credential: string, networks?: string[], refreshToken?: string) {
    const body = new URLSearchParams({ grant_type: oauth.grant });
    if (oauth.grant === 'client_credentials' && oauth.scope) body.set('scope', oauth.scope);
    if (refreshToken !== undefined) body.set('refresh_token', refreshToken);
    const encode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
    const header = Buffer.from(encode(oauth.clientId) + ':' + encode(credential)).toString('base64');
    const reply = await this.transport(oauth.tokenUrl, {
      method: 'POST', body: body.toString(), networks, signal: AbortSignal.timeout(10000),
      headers: { authorization: 'Basic ' + header, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    }).catch((error: unknown) => {
      if (oauth.grant === 'refresh_token' && (error instanceof PermissionDenied || error instanceof SourceRequestNotDispatched))
        throw new SourceOAuthRejection(error);
      throw error;
    });
    let raw: unknown;
    try { raw = JSON.parse(reply.body); } catch { throw new SourceReadFailure('Source OAuth token response is invalid'); }
    if (reply.status < 200 || reply.status >= 300) {
      const error = z.object({ error: z.string() }).safeParse(raw);
      if (reply.status >= 400 && reply.status < 500 && error.success && knownRejections.has(error.data.error))
        throw new SourceOAuthRejection();
      throw new SourceReadFailure('Source OAuth token exchange failed');
    }
    const parsed = tokenResponse.safeParse(raw);
    if (!parsed.success) throw new SourceReadFailure('Source OAuth token is invalid');
    return { value: parsed.data.access_token, validUntil: Date.now() + Math.max(0, (parsed.data.expires_in ?? 0) - 5) * 1000,
      refreshToken: parsed.data.refresh_token };
  }

  async send(source: string, expectedBinding: string, raw: unknown, context: OutboundContext): Promise<ReadResponse> {
    try {
      if (this.binding(source) !== expectedBinding) throw new PermissionDenied('The published Source connection changed');
      const connection = this.connections[source]!;
      const parsed = outboundRequest.safeParse(raw);
      if (!parsed.success) throw new InvalidInput('Invalid Source request');
      const { path, method, body, contentType } = parsed.data;
      if (!connection.methods.includes(method) || context.mode === 'read' && !['GET', 'HEAD'].includes(method))
        throw new PermissionDenied('The Source request method is not allowed');
      if (body !== undefined && ['GET', 'HEAD'].includes(method)) throw new InvalidInput('A read request cannot have a body');
      const url = targetUrl(connection, path);
      await context.authorize(source, method);
      const headers: Record<string, string> = { accept: 'application/json, text/plain' };
      if (body !== undefined) headers['content-type'] = contentType;
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]);
      const oauth = connection.oauth;
      let credential: string | undefined;
      if (oauth) {
        credential = oauth.grant === 'refresh_token'
          ? await this.refreshToken(source, method, oauth, context, connection.networks, signal)
          : (await this.clientToken(source, oauth, context, connection.networks)).value;
        await context.authorize(source, method);
      } else if (connection.bearerSecret) credential = await context.secret(connection.bearerSecret);
      if ((connection.bearerSecret || connection.oauth) && (!credential || /[\r\n]/.test(credential)))
        throw new PermissionDenied('Source credential is unavailable');
      if (credential) headers.authorization = 'Bearer ' + credential;
      signal.throwIfAborted();
      const response = await this.transport(url, { method, body, headers, networks: connection.networks, signal });
      if (response.status >= 300 && response.status < 400) throw new PermissionDenied('Source redirects are not allowed');
      if (credential && (response.body.includes(credential) || response.contentType?.includes(credential)))
        throw new SourceReadFailure('Source response cannot be returned');
      this.audit({ source, outcome: 'returned', status: response.status });
      return response;
    } catch (error) {
      const denied = error instanceof PermissionDenied || error instanceof InvalidInput;
      this.audit({ source, outcome: denied ? 'denied' : 'failed' });
      if (context.signal.aborted) throw context.signal.reason;
      if (denied || error instanceof SourceOAuthReauthorization) throw error;
      throw new SourceReadFailure('Source request failed');
    }
  }
}

export type ConfiguredComponentSources = {
  egress: ComponentSourceEgress;
  secrets?: Pick<ComponentSourceSecrets, 'get'>;
};

export function configuredComponentSources(db: Database, env = process.env): ConfiguredComponentSources | undefined {
  const file = env.EIGOS_COMPONENT_SOURCES_FILE;
  if (!file) return undefined;
  const bundle = env.EIGOS_COMPONENT_SOURCE_SECRETS_FILE, key = env.EIGOS_COMPONENT_SOURCE_SECRETS_KEY_FILE;
  if (Boolean(bundle) !== Boolean(key)) throw new Error('Configure both component Source secrets files');
  const secrets = bundle && key ? new ComponentSourceSecrets(bundle, key) : undefined;
  return {
    egress: new ComponentSourceEgress(JSON.parse(readFileSync(file, 'utf8')), undefined, undefined,
      secrets && new ComponentOAuthGrants(db, secrets)),
    ...(secrets ? { secrets } : {}),
  };
}
