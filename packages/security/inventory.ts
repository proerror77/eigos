import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { digest } from '../core/delegation.js';
import { currentKernelImplementation } from '../ontology/definition-store.js';
import { type ModelDefinition, OntologyModel } from '../ontology/model.js';
import { fieldPolicySchema, POLICY_VERSION, securityDefaults, resourceDefaults } from './contracts.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const securityBaselineSchema = z.strictObject({
  version: z.literal(POLICY_VERSION), enforcement: z.literal('not_installed'),
  model: z.strictObject({ id: z.string(), version: z.string(), digest: sha }),
  types: z.record(z.string(), z.strictObject({ fingerprint: sha, fields: z.record(z.string(), fieldPolicySchema) })),
  surfaces: z.array(z.strictObject({ id: z.string(), file: z.string(), sourceDigest: sha, channels: z.array(z.string()).min(1),
    content: z.string(), currentControl: z.string(), targetControl: z.string(), stage: z.enum(['S1', 'S2', 'S3', 'S4', 'S5']) })).min(1),
});
export type SecurityBaseline = z.infer<typeof securityBaselineSchema>;

// Include unions, arrays, references and open records in the nested-field audit.
// A parent policy covers the WHOLE subtree. No leaf inferred from a name is public.
export function schemaPaths(schema: unknown): { paths: string[]; openContent: boolean } {
  const paths = new Set<string>(); let openContent = false;
  function walk(value: unknown, path: string, depth: number) {
    if (depth > 40) throw new Error('Security inventory schema nesting exceeds its bound');
    paths.add(path);
    if (value === true) { openContent = true; paths.add(`${path}.*`); return; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const s = value as Record<string, unknown>;
    if (Object.keys(s).every(k => ['$schema', 'description', 'title'].includes(k))) { openContent = true; paths.add(`${path}.*`); }
    if (s.$ref) { openContent = true; paths.add(`${path}.$ref`); }
    if (s.properties && typeof s.properties === 'object') for (const [k, child] of Object.entries(s.properties)) walk(child, `${path}.${k}`, depth + 1);
    if (s.items) walk(s.items, `${path}[]`, depth + 1);
    if (Array.isArray(s.prefixItems)) s.prefixItems.forEach((child, i) => walk(child, `${path}[${i}]`, depth + 1));
    for (const k of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(s[k])) (s[k] as unknown[]).forEach(child => walk(child, path, depth + 1));
    if (s.additionalProperties !== undefined && s.additionalProperties !== false) { openContent = true; walk(s.additionalProperties, `${path}.*`, depth + 1); }
    if (s.type === 'object' && s.additionalProperties === undefined) { openContent = true; paths.add(`${path}.*`); }
  }
  walk(schema, '$', 0);
  return { paths: [...paths].sort(), openContent };
}

export function buildSecurityInventory(input: unknown, definition?: ModelDefinition, root?: string) {
  const baseline = securityBaselineSchema.parse(input), model = definition ? new OntologyModel(definition) : currentKernelImplementation();
  definition ??= model.definitionSnapshot();
  const issues: string[] = [];
  if (digest(baseline.model) !== digest(model.ref)) issues.push('model_definition_changed');
  const known = new Set(definition.objects.map(o => o.id));
  for (const type of Object.keys(baseline.types)) if (!known.has(type)) issues.push(`removed_type:${type}`);
  const types = definition.objects.map(o => {
    const reviewed = baseline.types[o.id];
    if (!reviewed) issues.push(`unreviewed_type:${o.id}`);
    else if (reviewed.fingerprint !== model.fingerprint(o.id)) issues.push(`definition_changed:${o.id}`);
    for (const name of Object.keys(reviewed?.fields ?? {})) if (!Object.hasOwn(o.properties, name)) issues.push(`removed_field:${o.id}.${name}`);
    const properties = Object.entries(o.properties).map(([name, p]) => {
      const policy = reviewed?.fields[name], schema = p.schemaMetadata ?? z.toJSONSchema(p.schema), coverage = schemaPaths(schema);
      if (!policy) issues.push(`unreviewed_field:${o.id}.${name}`);
      if (p.restricted && policy !== 'internal_only') issues.push(`restricted_field_weakened:${o.id}.${name}`);
      if (p.derived && policy !== 'derived_from_inputs') issues.push(`derived_policy_missing:${o.id}.${name}`);
      if (coverage.openContent && policy !== 'internal_only') issues.push(`open_content_not_internal:${o.id}.${name}`);
      return { name, policy: policy ?? 'unreviewed_deny', appliesTo: 'entire_subtree', schemaDigest: digest(schema), ...coverage, restricted: !!p.restricted, ...(p.derived ? { derivedFunction: p.derived } : {}) };
    });
    return { id: o.id, version: o.version, fingerprint: model.fingerprint(o.id), rowPolicy: 'owner_and_explicit_task_grant', migration: 'no_automatic_grants', properties };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(baseline.surfaces.map(s => s.id)).size !== baseline.surfaces.length) issues.push('duplicate_surface');
  if (root) for (const s of baseline.surfaces) {
    if (!/^(apps|packages|scripts|integrations)\/[A-Za-z0-9_./-]+\.(ts|mjs|cjs|py)$/.test(s.file) || s.file.split('/').includes('..')) { issues.push(`invalid_surface_path:${s.id}`); continue; }
    try { if (digest(readFileSync(resolve(root, s.file), 'utf8')) !== s.sourceDigest) issues.push(`surface_changed:${s.id}`); }
    catch { issues.push(`surface_unavailable:${s.id}`); }
  }
  return { stage: 'S0', enforcement: 'not_installed', version: POLICY_VERSION, baselineDigest: digest(baseline), model: model.ref,
    counts: { objectTypes: types.length, interfaces: definition.interfaces.length, links: definition.links.length,
      actions: definition.actions.length, functions: definition.functions.length, properties: types.reduce((n, t) => n + t.properties.length, 0),
      nestedPaths: types.flatMap(t => t.properties).reduce((n, p) => n + p.paths.length, 0), surfaces: baseline.surfaces.length },
    defaults: securityDefaults, resourceDefaults, types,
    interfaces: definition.interfaces.map(i => ({ id: i.id, policy: 'resource_view_and_concrete_type_policy', fingerprint: digest(model.describeType(i.id)) })),
    links: definition.links.map(l => ({ id: l.id, from: l.from.type, to: l.to.type, policy: 'both_endpoints_and_task_binding', fingerprint: digest(l) })),
    actions: definition.actions.map(a => ({ id: a.id, policy: 'independent_execution_and_existing_plan_grant', fingerprint: digest(a) })),
    functions: definition.functions.map(f => ({ id: f.id, policy: 'caller_scoped_inputs_and_derived_output', fingerprint: digest(f) })),
    surfaces: baseline.surfaces, issues, passed: issues.length === 0 };
}
