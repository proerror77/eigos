import { z } from 'zod';
import { CSV_CHECKS } from './csv-audit.js';
import { objectRefSchema, type ActionDefinition, type LinkDefinition, type ObjectTypeDefinition, type PropertyDefinition } from './model.js';
import { citationPort } from './document-action.js';
import type { CompositionPort } from './composition-contract.js';

export const briefInputSchema = z.object({ goal: z.string().trim().min(1).max(10000), deliverable: z.string().trim().min(1).max(4000) }).strict();
export const csvInputSchema = z.object({ fileName: z.string().min(1).max(200), checks: z.array(z.enum(CSV_CHECKS)).length(CSV_CHECKS.length).refine(values => new Set(values).size === CSV_CHECKS.length, 'Full audit only; subset checks are unsupported') }).strict();
const text = z.string().min(1).max(200), sha = z.string().regex(/^[a-f0-9]{64}$/), data = z.record(z.string(), z.unknown());
export const localReceiptSchema = z.strictObject({ configurationDigest: sha, scope: objectRefSchema, planId: z.uuid(), intentId: z.uuid(), attemptId: z.uuid(), inputDigest: sha, observedAt: z.iso.datetime({ offset: true }), evidenceRefs: z.array(text).min(1).max(30), deliveryDigest: sha, artifactName: text, preview: z.string().max(24000), previewComplete: z.boolean() });
export const csvSourceSchema = z.strictObject({ configurationDigest: sha, scope: objectRefSchema, planId: z.uuid(), intentId: z.uuid(), attemptId: z.uuid(),
  fileName: z.string().min(1).max(200), inputSha256: sha, byteLength: z.number().int().positive().max(1048576), rowCount: z.number().int().min(1).max(1000),
  observedAt: z.iso.datetime({ offset: true }), expiresAt: z.iso.datetime({ offset: true }), evidenceRefs: z.array(text).min(1),
  approval: z.strictObject({ amount: z.strictObject({ minor: z.string().regex(/^\d+$/), currency: z.string().min(3).max(3) }), environment: z.literal('local_simulation') }),
});
export const localActionSchemas = {
  PrepareTaskBrief: z.strictObject({ scope: objectRefSchema.extend({ type: z.literal('BriefTask') }) }),
  ReadCsvAuditSource: z.strictObject({ scope: objectRefSchema.extend({ type: z.literal('CsvAuditTask') }) }),
  AuditCsvSnapshot: z.strictObject({ scope: objectRefSchema.extend({ type: z.literal('CsvAuditTask') }), source: objectRefSchema.extend({ type: z.literal('CsvSnapshot') }) }),
};
const field = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string, restricted = false): PropertyDefinition => ({ kind, schema, description, required: true, restricted, source: 'Owned local input and original accepted atomic operation' });
const common = { id: field('string', text, 'Immutable local identity'), displayTitle: field('string', text, 'Local artifact label'), requestRevision: field('integer', z.number().int().positive(), 'Original request revision') };
export const localArtifactObjects: ObjectTypeDefinition[] = [
  ...[['BriefTask', briefInputSchema], ['CsvAuditTask', csvInputSchema]].map(([id, schema]): ObjectTypeDefinition => ({ id: String(id), name: String(id), aliases: [String(id)], version: '1', description: 'Pure user request context; initialization performs no file read or business execution', primaryKey: 'id', titleKey: 'displayTitle', properties: { ...common, input: field('struct', schema as z.ZodType, 'Exact user input'), configurationDigest: field('string', sha, 'Exact configured local implementation') } })),
  { id: 'TaskBrief', name: '任务说明', aliases: ['TaskBrief'], version: '1', description: 'A task brief with underlying execution explicitly not started', primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'CitableObject' }], properties: { ...common, receipt: field('struct', localReceiptSchema, 'Original input and independently verified brief') } },
  { id: 'CsvSnapshot', name: 'CSV 输入快照', aliases: ['CsvSnapshot'], version: '1', description: 'Bounded user file snapshot; public metadata and separately restricted raw bytes', primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'CitableObject' }], properties: { ...common, snapshot: field('struct', csvSourceSchema, 'File identity, scope and simulated approval terms') } },
  { id: 'CsvAuditReport', name: 'CSV 审计报告', aliases: ['CsvAuditReport'], version: '1', description: 'Full local CSV audit independently checked against the exact original bytes', primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'CitableObject' }], properties: { ...common, receipt: field('struct', localReceiptSchema, 'Original audit and independent acceptance receipt') } },
];
export const localArtifactLinks: LinkDefinition[] = [
  ...localArtifactObjects.map(object => ({ id: `${object.id}Request`, description: 'Owned original request', from: { type: object.id, name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: `local${object.id}`, many: true } })),
  ...(['TaskBrief', 'CsvSnapshot', 'CsvAuditReport'] as const).flatMap(type => [
    { id: `${type}Scope`, description: 'Original local component context', from: { type, name: 'scope', many: false, required: true }, to: { type: type === 'TaskBrief' ? 'BriefTask' : 'CsvAuditTask', name: `results${type}`, many: true } },
  ]),
  { id: 'CsvReportSource', description: 'Exact original user file for the independently verified audit', from: { type: 'CsvAuditReport', name: 'source', many: false, required: true }, to: { type: 'CsvSnapshot', name: 'reports', many: true } },
];
const port = (type: string, phase: CompositionPort['semantics']['phase'], origin: 'managed' | 'user'): CompositionPort => ({ kind: 'object', type, cardinality: 'one', semantics: { role: type, phase }, evidence: { origins: [origin] } });
export const localArtifactActions: ActionDefinition[] = Object.entries(localActionSchemas).map(([id, schema]): ActionDefinition => {
  const read = id === 'ReadCsvAuditSource', scope = id === 'PrepareTaskBrief' ? 'BriefTask' : 'CsvAuditTask', result = id === 'PrepareTaskBrief' ? 'TaskBrief' : read ? 'CsvSnapshot' : 'CsvAuditReport';
  const inputs: Record<string, string> = { scope }, ports: Record<string, CompositionPort> = { scope: port(scope, 'request', 'managed') };
  if (id === 'AuditCsvSnapshot') { inputs.source = 'CsvSnapshot'; ports.source = port('CsvSnapshot', 'fact', 'user'); }
  return { id, version: '1', kind: read ? 'source_read' : 'business', description: id === 'PrepareTaskBrief' ? 'Preserve exactly the requested brief; underlying business execution stays not_started.' : read ? 'Read and validate the explicitly configured local CSV file once; keep original bytes private. No audit or simulated approval occurs yet.' : 'Run all registered CSV checks against the accepted frozen bytes after exact local simulated approval, then independently verify both report formats. No real payment or repair.', inputs, resultTypes: [result], effects: [read ? 'read' : 'local'], changes: [result], submissionCriteria: ['same_owner', 'current_request_revision', 'original_input'],
    ...(read ? { read: { version: '1', effect: 'read', inputSchema: z.toJSONSchema(schema), resultType: result } } : { operation: { version: '1', effect: 'local', environment: 'local', inputSchema: z.toJSONSchema(schema), resultType: result } }),
    composition: { version: '1', inputs: ports, outputs: { result: port(result, read ? 'fact' : 'artifact', read ? 'user' : 'managed'), citations: { ...citationPort(result), evidence: { origins: read ? ['user'] : ['managed'] } } }, checks: [], effectScope: { effects: [read ? 'read' : 'local'], targetInputs: [], recovery: { kind: 'none' }, compensation: [] } } };
});
