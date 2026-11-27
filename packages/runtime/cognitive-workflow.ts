import { z } from 'zod';
import { Conflict, digest, requireScope } from '../core/identity.js';
import { validator } from '../ontology/model.js';
import { objectRefSchema, type ObjectRef } from '../ontology/schema.js';
import type { Access } from './access.js';
import type { PublishedOntology } from './metadata.js';
import type { Database, Sql } from './database.js';
import type { Functions, FunctionContext } from './functions.js';
import { actionEffects } from './action-values.js';

const name = z.string().min(1).max(80);
const reviewer = z.string().min(1).max(200);
export const cognitiveStepSchema = z.strictObject({
  name,
  mergeAction: name,
  mergeObjectParameter: name,
  goal: z.string().trim().min(1).max(2000),
  actions: z.array(name).min(1).max(20),
  functions: z.array(name).max(20).default([]),
  validation: z.strictObject({ function: name, objectParameter: name }),
  reviewers: z.array(reviewer).min(1).max(20),
  timeoutSeconds: z.number().int().min(30).max(86400).default(900),
  maxToolCalls: z.number().int().min(1).max(60).default(24),
});
export const cognitiveContextSchema = cognitiveStepSchema.omit({ reviewers: true, timeoutSeconds: true, mergeAction: true, mergeObjectParameter: true }).extend({
  runId: z.uuid(),
  scenarioId: z.uuid(),
  object: objectRefSchema,
  revision: z.number().int().positive(),
  evidenceVersion: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type CognitiveStep = z.output<typeof cognitiveStepSchema>;
export type CognitiveContext = z.output<typeof cognitiveContextSchema>;

export function authorizeCognitive(access: Access, model: PublishedOntology, step: CognitiveStep) {
  requireScope(access.principal, 'tasks:write');
  requireScope(access.principal, 'tasks:read');
  if (step.reviewers.includes(access.principal.owner)) throw new Conflict('Proposal reviewers must be separate identities');
  access.action(model, step.mergeAction);
  if (['scenarioId', 'revision'].includes(step.mergeObjectParameter) || !model.action(step.mergeAction).objectParameters[step.mergeObjectParameter])
    throw new Conflict('Workflow merge needs a published object parameter');
  for (const name of step.actions) {
    access.action(model, name);
    const action = model.action(name);
    if (action.effects?.length || action.rules?.some(rule => rule.op === 'applyScenario'))
      throw new Conflict('A proposal step cannot stage an external effect or merge a Scenario');
  }
  for (const name of [...step.functions, step.validation.function]) {
    const definition = model.functions.get(name);
    if (!definition || definition.edits || definition.source)
      throw new Conflict('A proposal step requires read-only Ontology Functions');
    access.function(model, name);
  }
}

export const cognitiveResultSchema = z.strictObject({
  scenarioId: z.uuid(),
  revision: z.number().int().positive(),
});

export function workflowMerge(model: PublishedOntology, step: CognitiveStep, object: ObjectRef, scenarioId: string, revision: number) {
  const action = step.mergeAction;
  const definition = model.action(action);
  const input = validator(definition.parameters).parse({
    [step.mergeObjectParameter]: object, scenarioId, revision,
  }) as Record<string, unknown>;
  return { action, input, effects: actionEffects(model, action, input) };
}

export async function validateCognitive(functions: Functions, context: FunctionContext,
  validation: CognitiveStep['validation'], object: ObjectRef) {
  const result = await functions.invoke(context.objects.model, validation.function, { [validation.objectParameter]: object }, context);
  if (result !== true && (!result || typeof result !== 'object' || !('valid' in result) || result.valid !== true))
    throw new Conflict('Workflow proposal failed its published validation');
}

/** Keep the original version check for proposals already created with an owner-wide snapshot. */
export async function decisionVersion(db: Database, model: PublishedOntology, owner: string, client: Sql = db.pool) {
  const { rows: [version] } = await db.readQuery(`SELECT
    (SELECT md5(coalesce(string_agg(md5(row(type,id,revision,properties,xmin)::text),'' ORDER BY type,id),'')) FROM ${db.schema}.objects WHERE projection=$1 AND owner=$2 AND type<>'OntologyScenario') AS objects,
    (SELECT md5(coalesce(string_agg(md5(row(type,from_type,from_id,to_type,to_id,xmin)::text),'' ORDER BY type,from_type,from_id,to_type,to_id),'')) FROM ${db.schema}.links WHERE projection=$1 AND owner=$2) AS links,
    (SELECT md5(coalesce(string_agg(md5(row(type,id,source,properties,observed_at,xmin)::text),'' ORDER BY type,id,source),'')) FROM ${db.schema}.source_values WHERE projection=$1 AND owner=$2) AS sources,
    (SELECT max(sequence)::text FROM ${db.schema}.edit_history WHERE projection=$1 AND owner=$2 AND type<>'OntologyScenario') AS edits`,
    [model.projection, owner], client);
  return digest({ release: model.release, version });
}

export async function requireDecisionVersion(db: Database, model: PublishedOntology, owner: string, version: string, client?: Sql) {
  if (await decisionVersion(db, model, owner, client) !== version)
    throw new Conflict('Workflow decision evidence changed; start a new proposal');
}
