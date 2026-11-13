import type { ObjectData, ObjectRef, OntologyDocument } from '../ontology/schema.js';
import type { Query } from '../runtime/objects.js';

export class OntologyHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: unknown,
  ) {
    super(
      typeof detail === 'object' && detail !== null && 'error' in detail
        ? String(detail.error)
        : `Ontology request failed (${status})`,
    );
    this.name = 'OntologyHttpError';
  }
}
export interface ClientOptions {
  baseUrl: string;
  token: string | (() => string | Promise<string>);
  ontology?: string;
  fetch?: typeof fetch;
}
export interface QueryResult<T = ObjectData> {
  items: T[];
  cursor?: string;
}
export interface ScenarioInfo {
  id: string;
  name: string;
  revision: number;
  state: string;
  expiresAt: string;
}
export interface ScenarioInspection extends ScenarioInfo {
  objects: {
    ref: ObjectRef;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    conflict: boolean;
  }[];
  links: { type: string; from: ObjectRef; to: ObjectRef; removed: boolean; conflict: boolean }[];
}
export interface ScenarioInput {
  requestId: string;
  name: string;
  description?: string;
  ttlSeconds?: number;
  kind?: 'persisted' | 'temporary';
  sessionId?: string;
}
export interface ActionInput {
  requestId: string;
  action: string;
  input: Record<string, unknown>;
}

/** Authenticated HTTP client. Credentials are supplied by the host and remain in its control. */
export class OntologyClient {
  private readonly base: URL;
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: ClientOptions) {
    this.base = new URL(options.baseUrl.endsWith('/') ? options.baseUrl : options.baseUrl + '/');
    if (!['https:', 'http:'].includes(this.base.protocol))
      throw new Error('Ontology URL must use HTTP or HTTPS');
    this.fetcher = options.fetch ?? globalThis.fetch;
  }
  get ontology() {
    return this.options.ontology;
  }
  async request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const token = typeof this.options.token === 'function' ? await this.options.token() : this.options.token;
    const response = await this.fetcher(new URL(path, this.base), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    let value: unknown;
    try {
      value = text ? JSON.parse(text) : null;
    } catch {
      throw new OntologyHttpError(response.status, { error: 'Ontology response was not JSON' });
    }
    if (!response.ok) throw new OntologyHttpError(response.status, value);
    return value as T;
  }
  query<T = ObjectData>(
    query: Query,
    options: { scenarioId?: string; taskId?: string; signal?: AbortSignal } = {},
  ): Promise<QueryResult<T>> {
    const { signal, ...scope } = options;
    return this.request('ontology/query', { query, ontology: this.ontology, ...scope }, signal);
  }
  evaluate<T>(
    name: string,
    input: Record<string, unknown>,
    options: { scenarioId?: string; taskId?: string; signal?: AbortSignal } = {},
  ): Promise<T> {
    const { signal, ...scope } = options;
    return this.request(
      'ontology/functions',
      { function: name, input, ontology: this.ontology, ...scope },
      signal,
    );
  }
  apply(input: ActionInput, options: { scenarioId?: string; signal?: AbortSignal } = {}): Promise<ObjectRef> {
    const { signal, ...scope } = options;
    return this.request('ontology/actions', { ...input, ontology: this.ontology, ...scope }, signal);
  }
  service<T>(operation: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    return this.request(
      `ontology/services/${encodeURIComponent(operation)}`,
      { ...input, _ontology: this.ontology },
      signal,
    );
  }
  async createScenario(input: ScenarioInput, signal?: AbortSignal): Promise<ScenarioClient> {
    const result = await this.request<{ id: string }>(
      'ontology/scenarios',
      { ...input, ontology: this.ontology },
      signal,
    );
    return this.scenario(result.id, input.sessionId);
  }
  scenario(id: string, sessionId?: string) {
    return new ScenarioClient(this, id, sessionId);
  }
  describe(signal?: AbortSignal) {
    return this.request<OntologyDocument>(
      'ontology' + (this.ontology ? '?ontology=' + encodeURIComponent(this.ontology) : ''),
      undefined,
      signal,
    );
  }
  async listScenarios(cursor?: string, signal?: AbortSignal): Promise<QueryResult<ScenarioInfo>> {
    const parameters = new URLSearchParams();
    if (this.ontology) parameters.set('ontology', this.ontology);
    if (cursor) parameters.set('cursor', cursor);
    const result = await this.request<
      QueryResult<{ id: string; name: string; revision: string | number; state: string; expiresAt?: string; expires_at: string }>
    >('ontology/scenarios' + (parameters.size ? '?' + parameters : ''), undefined, signal);
    return {
      ...result,
      items: result.items.map((row) => ({
        id: row.id,
        name: row.name,
        revision: Number(row.revision),
        state: row.state,
        expiresAt: row.expiresAt ?? row.expires_at,
      })),
    };
  }
  async openSession(ttlSeconds = 3600, signal?: AbortSignal) {
    return this.service<{ id: string; expiresAt: string }>('open_scenario_session', { ttlSeconds }, signal);
  }
  closeSession(sessionId: string, signal?: AbortSignal) {
    return this.service<{ sessionId: string; closed: boolean }>(
      'close_scenario_session',
      { sessionId },
      signal,
    );
  }
  undo(originalRequestId: string, requestId: string, signal?: AbortSignal) {
    return this.service<{
      requestId: string;
      originalRequestId: string;
      result: ObjectRef;
      externalEffectsReversed: false;
    }>('undo_action', { originalRequestId, requestId }, signal);
  }
}

export class ScenarioClient {
  constructor(
    private readonly client: OntologyClient,
    readonly id: string,
    readonly sessionId?: string,
  ) {}
  query<T = ObjectData>(query: Query, signal?: AbortSignal) {
    return this.client.query<T>(query, { scenarioId: this.id, signal });
  }
  evaluate<T>(name: string, input: Record<string, unknown>, signal?: AbortSignal) {
    return this.client.evaluate<T>(name, input, { scenarioId: this.id, signal });
  }
  apply(input: ActionInput, signal?: AbortSignal) {
    return this.client.apply(input, { scenarioId: this.id, signal });
  }
  inspect(signal?: AbortSignal) {
    const search = this.client.ontology ? '?ontology=' + encodeURIComponent(this.client.ontology) : '';
    return this.client.request<ScenarioInspection>(
      `ontology/scenarios/${encodeURIComponent(this.id)}${search}`,
      undefined,
      signal,
    );
  }
  discard(revision: number, signal?: AbortSignal) {
    return this.client.request<ScenarioInfo>(
      `ontology/scenarios/${encodeURIComponent(this.id)}/discard`,
      { revision, ontology: this.client.ontology },
      signal,
    );
  }
  share(revision: number, readers: string[], signal?: AbortSignal) {
    return this.client.service<{ id: string; revision: number; readers: string[] }>(
      'share_scenario',
      { id: this.id, revision, readers },
      signal,
    );
  }
  /** Merge Actions conventionally bind scenarioId and the explicitly reviewed revision. */
  merge(
    action: string,
    requestId: string,
    revision: number,
    input: Record<string, unknown> = {},
    signal?: AbortSignal,
  ) {
    return this.client.apply(
      { action, requestId, input: { ...input, scenarioId: this.id, revision } },
      { signal },
    );
  }
  closeSession(signal?: AbortSignal) {
    if (!this.sessionId) throw new Error('This scenario is not attached to a temporary session');
    return this.client.closeSession(this.sessionId, signal);
  }
}
