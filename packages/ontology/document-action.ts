import { z } from 'zod';
import { objectRefSchema, type ActionDefinition, type ObjectTypeDefinition, type PropertyDefinition, type LinkDefinition } from './model.js';
import type { CompositionPort } from './composition-contract.js';

const text = z.string().min(1).max(200), sha = z.string().regex(/^[a-f0-9]{64}$/);
export const documentTaskSchema = z.strictObject({ format: z.literal('markdown') });
export const documentActionSchema = z.strictObject({
  scope: objectRefSchema.extend({ type: z.literal('DocumentTask') }),
  citations: z.array(objectRefSchema).max(12).optional(), additionalCitations: z.array(objectRefSchema).max(12).optional(),
});
export const documentCompletionSchema = z.strictObject({ document: objectRefSchema.extend({ type: z.literal('DocumentDraft') }) });
export const documentDraftSchema = z.strictObject({
  id: text, requestId: text, requestRevision: z.number().int().positive(), configurationDigest: sha,
  scope: objectRefSchema.extend({ type: z.literal('DocumentTask') }), actionInputDigest: sha,
  planId: text, intentId: text, attemptId: text, decisionRunId: text, modelRunId: text,
  createdAt: z.iso.datetime({ offset: true }), status: z.enum(['draft', 'needs_input']),
  markdown: z.string().max(40000), message: z.string().min(1).max(8000), contentDigest: sha,
  citations: z.array(z.strictObject({ object: objectRefSchema, revision: z.number().int().positive(), propertiesDigest: sha, receiptDigest: sha, evidenceRefs: z.array(text).min(1).max(20) })).max(24),
  noExternalActions: z.literal(true),
});
export type DocumentDraft = z.infer<typeof documentDraftSchema>;
export function citationPort(type: string): CompositionPort {
  return { kind: 'object', type, cardinality: 'many', semantics: { role: 'source_citation', phase: 'fact' }, evidence: { origins: ['provider', 'synthetic', 'managed', 'model', 'user'], maxAgeMs: 300000 } };
}
const p = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string): PropertyDefinition => ({ kind, schema, description, required: true, source: 'Owned document request or original bounded model receipt; never external business truth' });
const base = { id: p('string', text, 'Immutable identity'), displayTitle: p('string', text, 'Safe document label'), requestRevision: p('integer', z.number().int().positive(), 'Request revision') };
export const documentObjects: ObjectTypeDefinition[] = [
  { id: 'DocumentTask', version: '1', name: '文档生成范围', aliases: ['DocumentTask'], description: 'Pure request context; no source fetch or model execution occurs during creation', primaryKey: 'id', titleKey: 'displayTitle', visibility: 'technical', properties: {
    ...base, input: p('struct', documentTaskSchema, 'Requested format'), configurationDigest: p('string', sha, 'Exact bounded document executor'), allowedActions: p('array', z.array(z.literal('ComposeDocument')).length(1), 'One model invocation; no external business effects'),
  } },
  { id: 'DocumentDraft', version: '1', name: '文档草稿', aliases: ['DocumentDraft'], description: 'An actual model-produced draft or an explicit information request, with accepted source citations. Proves artifact creation only.', primaryKey: 'id', titleKey: 'displayTitle', properties: {
    ...base, snapshot: p('struct', documentDraftSchema, 'Original generated content, receipt and exact cited object revisions'),
  } },
];
export const documentLinks: LinkDefinition[] = [
  { id: 'DocumentTaskRequest', description: 'Document context belongs to the task', from: { type: 'DocumentTask', name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: 'documentTasks', many: true } },
  { id: 'DocumentDraftRequest', description: 'Generated document belongs to the original request', from: { type: 'DocumentDraft', name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: 'documents', many: true } },
  { id: 'DocumentDraftScope', description: 'Document was created under this exact scope', from: { type: 'DocumentDraft', name: 'scope', many: false, required: true }, to: { type: 'DocumentTask', name: 'drafts', many: true } },
  { id: 'DocumentDraftCitation', description: 'Accepted source evidence cited by the document; a draft cannot promote its evidence phase', from: { type: 'DocumentDraft', name: 'citations', many: true }, to: { type: 'CitableObject', name: 'citingDocuments', many: true } },
];
export const documentAction: ActionDefinition = {
  id: 'ComposeDocument', version: '1', kind: 'business', description: 'Generate one Markdown document from the original goal, confirmed user inputs and explicitly selected accepted citations. Tools and external actions are disabled. A draft is not proof of the business facts it describes.',
  inputs: { scope: 'DocumentTask', citations: 'CitableObject', additionalCitations: 'CitableObject' }, resultTypes: ['DocumentDraft'], effects: ['local'], changes: ['DocumentDraft'],
  submissionCriteria: ['same_owner', 'current_request_revision', 'accepted_citations', 'current_citation_versions', 'bounded_model_calls'],
  operation: { version: '1', effect: 'local', environment: 'local', inputSchema: z.toJSONSchema(documentActionSchema), resultType: 'DocumentDraft' },
  composition: { version: '1', inputs: { scope: { kind: 'object', type: 'DocumentTask', cardinality: 'one', semantics: { role: 'DocumentTask', phase: 'request' }, evidence: { origins: ['managed'] } }, citations: { ...citationPort('CitableObject'), optional: true }, additionalCitations: { ...citationPort('CitableObject'), optional: true } },
    outputs: { result: { kind: 'object', type: 'DocumentDraft', cardinality: 'one', semantics: { role: 'document_draft', phase: 'artifact' }, evidence: { origins: ['model'] } } },
    checks: [], effectScope: { effects: ['local'], targetInputs: [], recovery: { kind: 'none' }, compensation: [] } },
};
