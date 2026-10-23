import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';

const field = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/).refine(v => !['constructor', 'prototype', '__proto__'].includes(v));
const path = z.array(field).min(1).max(8);
const argument = z.discriminatedUnion('from', [
  z.strictObject({ from: z.literal('input'), path }),
  z.strictObject({ from: z.literal('scope'), path }),
  z.strictObject({ from: z.literal('selection'), name: field, path }),
]);
export const mcpDependencySchema = z.strictObject({
  name: field, action: field, objectType: field, observationInput: field,
  selectionInput: field, role: field, evaluate: field,
});
export type McpReadDependency = z.infer<typeof mcpDependencySchema>;
export const mcpReadBindingSchema = z.strictObject({
  server: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  tool: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/),
  arguments: z.record(field, argument).refine(v => Object.keys(v).length > 0 && Object.keys(v).length <= 32),
  requires: z.array(mcpDependencySchema).max(8),
  inputMatchesScope: z.array(z.strictObject({ input: field, byInput: field, scopeFields: z.record(field, field) })).max(8),
  route: z.record(field, field).optional(),
}).superRefine((value, ctx) => {
  const names = value.requires.map(r => r.name);
  if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', message: 'Duplicate MCP dependency name' });
  for (const a of Object.values(value.arguments)) if (a.from === 'selection' && !names.includes(a.name)) ctx.addIssue({ code: 'custom', message: 'Unresolved MCP parameter dependency' });
  for (const name of Object.values(value.route ?? {})) if (!names.includes(name)) ctx.addIssue({ code: 'custom', message: 'Unresolved MCP route dependency' });
});
export type McpReadBinding = z.infer<typeof mcpReadBindingSchema>;
const readModuleSchema = z.strictObject({
  format: z.literal('eigos.ontology.mcp-reads.v1'),
  id: z.string().regex(/^[a-z][a-z0-9.-]{0,99}$/), version: z.string().regex(/^[1-9][0-9]*$/),
  completion: z.strictObject({ evaluate: field }),
  actions: z.array(z.strictObject({ id: field, description: z.string().min(1).max(3000), resultType: field, mcp: mcpReadBindingSchema })).min(1).max(32),
});
export type McpReadModule = z.infer<typeof readModuleSchema>;
const invalid = (message: string): never => { throw new DomainError('CONFLICT', message); };
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** Trusted, independently versioned data. No code, URLs, credentials or grants. */
export function parseMcpReadModule(value: unknown): McpReadModule {
  const module = readModuleSchema.parse(value), actions = new Map(module.actions.map(a => [a.id, a]));
  if (actions.size !== module.actions.length) invalid('Duplicate ontology MCP action');
  const visited = new Set<string>();
  const visit = (id: string, active: Set<string>) => {
    if (active.has(id)) invalid('Cyclic ontology MCP dependencies');
    if (visited.has(id)) return;
    for (const dep of actions.get(id)!.mcp.requires) {
      if (actions.get(dep.action)?.resultType !== dep.objectType) invalid('Unresolved ontology MCP dependency action or result type');
      visit(dep.action, new Set(active).add(id));
    }
    visited.add(id);
  };
  for (const action of module.actions) visit(action.id, new Set());
  return freeze(module);
}
export function loadMcpReadModule(file: string | URL): McpReadModule {
  const bytes = readFileSync(file);
  if (bytes.length > 128000) invalid('Ontology MCP definition exceeds its size limit');
  return parseMcpReadModule(JSON.parse(bytes.toString('utf8')));
}
export const mcpReadModuleRef = (module: McpReadModule) => ({ id: module.id, version: module.version, digest: digest(module) });
function at(value: unknown, keys: string[]): unknown {
  for (const key of keys) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) invalid('Ontology MCP parameter source is missing');
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Interprets one model-selected action. It never schedules a dependency or a next action. */
export function resolveOntologyMcpRead(binding: McpReadBinding, input: Record<string, unknown>, scope: Record<string, unknown>,
  select: (dependency: McpReadDependency) => unknown) {
  const current = mcpReadBindingSchema.parse(binding);
  for (const match of current.inputMatchesScope) {
    const discriminator = z.string().parse(at(input, [match.byInput]));
    if (!Object.hasOwn(match.scopeFields, discriminator)) invalid('Ontology MCP input has no matching scope field');
    if (digest(at(input, [match.input])) !== digest(at(scope, [match.scopeFields[discriminator]!]))) invalid('Ontology MCP input differs from the requested scope');
  }
  const selections = Object.fromEntries(current.requires.map(dependency => [dependency.name, select(dependency)]));
  const args = Object.fromEntries(Object.entries(current.arguments).map(([key, source]) => {
    const value = at(source.from === 'input' ? input : source.from === 'scope' ? scope : selections[source.name], source.path);
    if (!['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) invalid('Ontology MCP arguments must resolve to scalar values');
    return [key, String(value)];
  }));
  return { server: current.server, tool: current.tool, args, selections,
    route: current.route ? Object.fromEntries(Object.entries(current.route).map(([role, name]) => [role, selections[name]])) : undefined };
}
