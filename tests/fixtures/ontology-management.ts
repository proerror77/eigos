import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../../apps/gateway/app.js';
import { readConfig } from '../../packages/core/config.js';
import { ownerKey, SCOPES, type Principal } from '../../packages/core/domain.js';
import type { DefinitionKind, SerializableAction, SerializableObjectType } from '../../packages/ontology/definition-contracts.js';

export async function startOntologyManagementFixture(mode: 'development' | 'jwt' = 'development') {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  const directory = mode === 'jwt' ? mkdtempSync(join(tmpdir(), 'eigos-metadata-member-')) : undefined;
  const publicUrl = mode === 'jwt' ? base.replace('http:', 'https:') : base;
  const scopes = SCOPES.filter(scope => scope !== 'ontology:admin');
  const actor = (subject: string, allowed: string[] = scopes): Principal => ({ issuer: 'https://metadata-fixture.test', tenant: 'office', subject, clientId: 'metadata-test-client', scopes: allowed });
  const people: Record<string, Principal> = { alice: actor('alice'), bob: actor('bob'), reader: actor('alice', ['ontology:read']), editor: actor('alice', ['ontology:read', 'ontology:write']), publisher: actor('alice', ['ontology:read', 'ontology:publish']), taskOnly: actor('alice', ['services:read', 'tasks:read', 'tasks:write']), adminOnly: actor('alice', ['ontology:admin']) };
  let gateway: ReturnType<typeof createApp>;
  try { gateway = createApp(readConfig({ EIGOS_AUTH_MODE: mode, EIGOS_DEV_TOKEN: 'ontology-management-loopback-fixture-only', OAUTH_ISSUER: people.alice!.issuer, OAUTH_AUDIENCE: publicUrl, OAUTH_JWKS_URL: people.alice!.issuer + '/jwks', DATABASE_PATH: ':memory:', ...(directory ? { MEMBERSHIP_DATABASE_PATH: join(directory, 'members.sqlite') } : {}), PUBLIC_URL: publicUrl }), async token => { const principal = people[token]; if (!principal) throw new Error('Invalid fixture credential'); return principal; }); }
  catch (error) { server.close(); if (directory) rmSync(directory, { recursive: true, force: true }); throw error; }
  server.on('request', gateway.app);
  const client = new Client({ name: 'ontology-modeler-fixture', version: '1' });
  const post = async (path: string, input: unknown, token = 'alice') => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(input) });
    return { status: response.status, value: await response.json() as any };
  };
  const http = async (path: string, input: unknown, token = 'alice') => { const response = await post(path, input, token); assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value.result as any; };
  const connect = () => client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer alice' } } }));
  const mcp = async (name: string, input: Record<string, unknown>) => { const response = await client.callTool({ name, arguments: input }); assert(!response.isError, JSON.stringify(response)); return (response.structuredContent as { result: any }).result; };
  const close = async () => { await client.close(); await gateway.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); if (directory) rmSync(directory, { recursive: true, force: true }); };
  return { base, gateway, server, client, people, owner: ownerKey(people.alice!), post, http, mcp, connect, close };
}

const textSchema = { type: 'string', minLength: 1, maxLength: 200 };
const properties = { id: { kind: 'string' as const, description: 'Stable identity', source: 'Owner input', required: true, schema: textSchema }, label: { kind: 'string' as const, description: 'Resource label', source: 'Owner input', required: true, schema: textSchema } };
const objectInput = (type: string) => ({ type: 'object', properties: { type: { type: 'string', const: type }, id: textSchema }, required: ['type', 'id'], additionalProperties: false });
const inputSchema = (fields: Record<string, unknown>) => ({ type: 'object', properties: fields, required: Object.keys(fields), additionalProperties: false });
const object = (id: string): SerializableObjectType => ({ resourceId: `office:object:${id}`, id, version: '1', name: id, aliases: [], description: 'Internal office resource data', primaryKey: 'id', titleKey: 'label', properties, writePolicy: 'managed' });
const create = (type: string): SerializableAction => ({ resourceId: `office:action:Create${type}`, id: `Create${type}`, version: '1', kind: 'business', description: `Create internal ${type} data`, effects: ['object_write'], inputs: {}, changes: [type], resultTypes: [type], submissionCriteria: ['exact_object_write_authority'], inputSchema: inputSchema({ id: textSchema, label: textSchema }), implementation: { kind: 'declarative', version: '1', conditions: [], mutations: [{ op: 'create', type, id: { parameter: 'id' }, properties: { id: { parameter: 'id' }, label: { parameter: 'label' } } }] } });
const request = (type: string, input: string): SerializableAction => ({ resourceId: `office:action:Request${type}`, id: `Request${type}`, version: '1', kind: 'business', description: `Record an internal use request for ${type}`, effects: ['object_write'], inputs: { [input]: type }, changes: ['OfficeRequest', 'OfficeRequest.resource'], resultTypes: ['OfficeRequest'], submissionCriteria: ['exact_object_write_authority'], inputSchema: inputSchema({ [input]: objectInput(type), id: textSchema, label: textSchema }), implementation: { kind: 'declarative', version: '1', conditions: [], mutations: [{ op: 'create', type: 'OfficeRequest', id: { parameter: 'id' }, properties: { id: { parameter: 'id' }, label: { parameter: 'label' } } }, { op: 'add_link', type: 'OfficeRequestResource', from: { type: 'OfficeRequest', id: { parameter: 'id' } }, to: { parameter: input } }], result: { type: 'OfficeRequest', id: { parameter: 'id' } } } });
export const officeManagementResources: { kind: DefinitionKind; definition: object }[] = [
  { kind: 'object', definition: { ...object('OfficeRoom'), interfaces: [{ id: 'OfficeResource', actionMap: { RequestUse: { actionId: 'RequestOfficeRoom', inputMap: { room: 'resource' } } } }] } },
  { kind: 'object', definition: { ...object('OfficeEquipment'), interfaces: [{ id: 'OfficeResource', actionMap: { RequestUse: { actionId: 'RequestOfficeEquipment', inputMap: { equipment: 'resource' } } } }] } },
  { kind: 'object', definition: object('OfficeRequest') },
  { kind: 'interface', definition: { resourceId: 'office:interface:OfficeResource', id: 'OfficeResource', description: 'Resources that accept internal requests', properties, actions: [{ id: 'RequestUse', inputs: { resource: 'OfficeResource' }, effects: ['object_write'], resultTypes: ['OfficeRequest'] }] } },
  { kind: 'link', definition: { resourceId: 'office:link:OfficeRequestResource', id: 'OfficeRequestResource', description: 'Internal request to resource', from: { type: 'OfficeRequest', name: 'resource', many: false, required: true }, to: { type: 'OfficeResource', name: 'requests', many: true }, writePolicy: 'managed' } },
  { kind: 'action', definition: create('OfficeRoom') }, { kind: 'action', definition: create('OfficeEquipment') },
  { kind: 'action', definition: request('OfficeRoom', 'room') }, { kind: 'action', definition: request('OfficeEquipment', 'equipment') },
  { kind: 'action', definition: { resourceId: 'office:action:RenameOfficeRoom', id: 'RenameOfficeRoom', version: '1', kind: 'business', description: 'Update the internal room label', effects: ['object_write'], inputs: { room: 'OfficeRoom' }, changes: ['OfficeRoom.label'], resultTypes: ['OfficeRoom'], submissionCriteria: ['exact_object_write_authority'], inputSchema: inputSchema({ room: objectInput('OfficeRoom'), expectedRevision: { type: 'integer', minimum: 1 }, label: textSchema }), implementation: { kind: 'declarative', version: '1', conditions: [], mutations: [{ op: 'update', object: { parameter: 'room' }, expectedRevision: { parameter: 'expectedRevision' }, properties: { label: { parameter: 'label' } } }] } } },
];

/** Every custom definition enters through the same authenticated HTTP/MCP surface. */
export async function installOfficeManagementFixture(f: Awaited<ReturnType<typeof startOntologyManagementFixture>>, mixMcp = false) {
  const namespace = await f.http('/ontology/v1/commands', { operation: 'create_ontology', id: 'office.operations', name: '办公室资源' });
  let draft = await f.http('/ontology/v1/commands', { operation: 'create_draft', ontologyId: namespace.id, title: '新增办公室资源与内部申请' });
  for (const [index, resource] of officeManagementResources.entries()) {
    const command = { operation: 'put_definition', ontologyId: namespace.id, draftId: draft.id, expectedRevision: draft.revision, ...resource };
    draft = mixMcp && index % 2 ? await f.mcp('manage_ontology_definitions', command) : await f.http('/ontology/v1/commands', command);
  }
  const validation = await f.http('/ontology/v1/query', { operation: 'validate_draft', ontologyId: namespace.id, draftId: draft.id }); assert.equal(validation.valid, true, JSON.stringify(validation));
  const published = await f.http('/ontology/v1/commands', { operation: 'publish_draft', ontologyId: namespace.id, draftId: draft.id, expectedRevision: draft.revision });
  const active = await f.http('/ontology/v1/commands', { operation: 'activate_release', ontologyId: namespace.id, release: published.release, expectedGeneration: namespace.generation });
  return { namespace: active, draft: published.draft, release: published.release };
}
