import { documentChunkType } from '../ontology/documents.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Conflict, NotFound, digest, type Principal } from '../core/identity.js';
import { objectRefSchema, type LinkData, type ObjectRef } from '../ontology/schema.js';
import type { ScenarioDecision, ScenarioDecisionMemory } from '../ontology/scenario-decision.js';
import { Access, PermissionDenied, type Requirement } from './access.js';
import { Database, type Sql } from './database.js';
import { Metadata, PublishedOntology } from './metadata.js';
import { Objects, type ScenarioObjectWrite, querySchema } from './objects.js';
import { ObjectSets } from './object-sets.js';
import { decisionEvidenceSchema, replayRead, type DecisionObservation } from './decision-evidence.js';
import { bumpScenario, checkScenario, lockEdits, objectLinks, recordScenarioAction, type ScenarioMutation } from './scenario-store.js';
import { scenarioMetadataRead, syncScenarioMetadata, removeScenarioMetadata } from './scenario-metadata.js';
import { appendTrace } from './execution-trace.js';
import { latestCommit } from './change-feed.js';
import { changeDigest } from './action-values.js';
import { cognitiveContextSchema, cognitiveStepSchema, decisionVersion, requireDecisionVersion, workflowMerge } from './cognitive-workflow.js';

type Properties = Record<string, unknown>;
type ScenarioObjectEdit = {
  type: string; id: string; base_revision: string | null; base_properties: Properties | null;
  base_links: unknown; properties: Properties | null; edited_fields: string[] | null;
};
type LiveObject = { revision: string; properties: Properties };
type ReviewableScenario = { id: string; owner: string; name: string; revision: string; reviewers: string[]; journal_steps: number; workflow_run_id: string | null };
type ContinuationRow = ReviewableScenario & {
  release: string; kind: string; expires_at: Date; action_count: number; complete_actions: number; has_changes: boolean;
};
type ScenarioStep = {
  action: string; request_id: string; digest: string; result: ObjectRef; input: Properties | null;
  requirements: Requirement[]; step_revision: string | null; edits: ScenarioMutation[] | null;
};
type ValidateAction = (prefix: Objects, action: string, input: Properties) => Promise<void>;
type DecisionCheckpoint = (prefix: Objects, step: number, offset: number) => Promise<void>;

export interface ScenarioDecisionContext {
  model: PublishedOntology;
  owner: string;
  reviewer: Access;
  client: Sql;
  review: {
    id: string; revision: number; snapshot: string;
    objects: { ref: ObjectRef; after: Properties | null }[];
    links: { type: string; from: ObjectRef; to: ObjectRef; removed: boolean }[];
  };
}
export interface ScenarioDecisionSupport {
  inspect(context: ScenarioDecisionContext): Promise<ScenarioDecisionMemory | undefined>;
  capture(context: ScenarioDecisionContext, decision: ScenarioDecision, approvedAt?: Date): Promise<void>;
  validateApproval(context: ScenarioDecisionContext): Promise<boolean>;
}

function recordedDecisionEvidence(raw: unknown) {
  const result = decisionEvidenceSchema.safeParse(raw);
  if (!result.success) throw new Conflict('Workflow decision evidence is unavailable; start a new proposal');
  return result.data;
}
const fieldValue = (values: Properties, field: string) => digest({ value: values[field] });
function editedFields(item: ScenarioObjectEdit): string[] {
  const before = item.base_properties ?? {}, after = item.properties ?? {};
  // Old proposals retained before/after values. Use those differences as the recoverable edits.
  const fields = new Set(item.edited_fields ?? []);
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (fieldValue(before, field) !== fieldValue(after, field)) fields.add(field);
  }
  return [...fields].sort();
}
function objectConflict(item: ScenarioObjectEdit, live: LiveObject | undefined, recorded: boolean) {
  const baseline = item.base_properties;
  if (!recorded)
    return (live?.revision ?? null) !== item.base_revision || digest(live?.properties ?? null) !== digest(baseline);
  if (!live || !baseline) return !!live !== !!baseline;
  if (item.base_revision !== null && BigInt(live.revision) < BigInt(item.base_revision)) return true;
  if (item.properties === null) return digest(live.properties) !== digest(baseline);
  return editedFields(item).some(field => fieldValue(live.properties, field) !== fieldValue(baseline, field));
}

export const createScenarioSchema = z.strictObject({
  requestId: z.string().min(1).max(128), name: z.string().min(1).max(200),
  kind: z.enum(['persisted','temporary']).default('persisted'), sessionId: z.uuid().optional(),
  description: z.string().max(2000).default(''), ttlSeconds: z.number().int().min(1).max(31*86400).optional(),
}).refine(input=>input.kind==='temporary'?Boolean(input.sessionId):!input.sessionId,'Temporary scenarios require a session');
export const continueScenarioSchema = z.strictObject({
  id:z.uuid(), revision:z.number().int().positive(), requestId:z.string().min(1).max(128),
});
export async function initializeScenarioLifecycle(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.scenario_sessions(
    id uuid PRIMARY KEY,owner text NOT NULL,expires_at timestamptz NOT NULL,closed_at timestamptz);
    ALTER TABLE ${db.schema}.scenarios ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'persisted';
    ALTER TABLE ${db.schema}.scenarios ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
    ALTER TABLE ${db.schema}.scenarios ADD COLUMN IF NOT EXISTS readers jsonb NOT NULL DEFAULT '[]';
    ALTER TABLE ${db.schema}.scenarios ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES ${db.schema}.scenario_sessions(id);
    ALTER TABLE ${db.schema}.scenarios ADD COLUMN IF NOT EXISTS creation_digest text;
    ALTER TABLE ${db.schema}.scenarios ADD COLUMN IF NOT EXISTS reviewers jsonb NOT NULL DEFAULT '[]';
    ALTER TABLE ${db.schema}.scenarios ADD COLUMN IF NOT EXISTS workflow_run_id uuid;
    ALTER TABLE ${db.schema}.scenarios ADD COLUMN IF NOT EXISTS journal_steps integer NOT NULL DEFAULT 0;
    -- S1 automatic sync: the creator's principal, the owner's last commit the Scenario was synced with, and its state.
    ALTER TABLE ${db.schema}.scenarios ADD COLUMN IF NOT EXISTS principal jsonb;
    ALTER TABLE ${db.schema}.scenarios ADD COLUMN IF NOT EXISTS sync_position bigint;
    ALTER TABLE ${db.schema}.scenarios ADD COLUMN IF NOT EXISTS sync_state text NOT NULL DEFAULT 'current';
    ALTER TABLE ${db.schema}.scenarios ADD COLUMN IF NOT EXISTS sync_error text;
    ALTER TABLE ${db.schema}.scenarios ADD COLUMN IF NOT EXISTS synced_at timestamptz;
    ALTER TABLE ${db.schema}.scenario_objects ADD COLUMN IF NOT EXISTS edited_fields jsonb;
    ALTER TABLE ${db.schema}.scenario_actions ADD COLUMN IF NOT EXISTS input jsonb;
    ALTER TABLE ${db.schema}.scenario_actions ADD COLUMN IF NOT EXISTS executor_kind text;
    ALTER TABLE ${db.schema}.scenario_actions ADD COLUMN IF NOT EXISTS executor_id text;
    ALTER TABLE ${db.schema}.scenario_actions ADD COLUMN IF NOT EXISTS task_id uuid;
    ALTER TABLE ${db.schema}.scenario_actions ADD COLUMN IF NOT EXISTS step_revision bigint;
    ALTER TABLE ${db.schema}.scenario_actions ADD COLUMN IF NOT EXISTS edits jsonb;
    CREATE UNIQUE INDEX IF NOT EXISTS scenario_actions_step_order ON ${db.schema}.scenario_actions(scenario_id,step_revision)
      WHERE step_revision IS NOT NULL;
    CREATE TABLE IF NOT EXISTS ${db.schema}.scenario_approvals (
      scenario_id uuid NOT NULL REFERENCES ${db.schema}.scenarios(id) ON DELETE CASCADE,
      owner text NOT NULL, revision bigint NOT NULL, reviewer text NOT NULL, snapshot text NOT NULL,
      approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(scenario_id,revision,reviewer));
    CREATE INDEX IF NOT EXISTS objects_scenario_metadata ON ${db.schema}.objects(id,projection,owner) WHERE type='OntologyScenario';`);
  const releases=(await db.query(`SELECT DISTINCT r.* FROM ${db.schema}.releases r JOIN ${db.schema}.scenarios s ON s.release=r.digest
    WHERE s.kind='persisted' AND s.expires_at>now() AND r.projection IS NOT NULL
    AND r.body->'objectTypes' @> '[{"apiName":"OntologyScenario"}]'::jsonb`)).rows;
  for(const release of releases){
    const model=new PublishedOntology(release.body,release.digest,release.projection,release.runtime_id,release.bindings);
    await db.transaction(async client=>{
      const ids=(await db.query(`SELECT id FROM ${db.schema}.scenarios WHERE release=$1 AND kind='persisted' AND expires_at>now() ORDER BY id FOR UPDATE`,[model.release],client)).rows;
      for(const row of ids)await syncScenarioMetadata(db,model,String(row.id),client);
    });
  }
}
export class Scenarios {
  constructor(private readonly db: Database, private readonly decisions?: ScenarioDecisionSupport) {}
  async openSession(access: Access, ttlSeconds=3600, client?: Sql) {
    z.number().int().min(1).max(86400).parse(ttlSeconds);
    const id=randomUUID();
    const row=(await this.db.query(`INSERT INTO ${this.db.schema}.scenario_sessions(id,owner,expires_at) VALUES($1,$2,now()+$3*interval '1 second') RETURNING id,expires_at`,[id,access.principal.owner,ttlSeconds],client)).rows[0]!;
    return {id:String(row.id),expiresAt:row.expires_at as Date};
  }
  async closeSession(access: Access, sessionId: string) {
    z.uuid().parse(sessionId);
    await this.db.query(`UPDATE ${this.db.schema}.scenario_sessions SET closed_at=coalesce(closed_at,now()) WHERE id=$1 AND owner=$2`,[sessionId,access.principal.owner]);
    await this.cleanup(sessionId,access.principal.owner);
    return {sessionId,closed:true};
  }
  async cleanup(sessionId?: string, owner?: string) {
    return this.db.transaction(async client=>{
      const rows=(await this.db.query<{id:string;owner:string;readers:string[]}>(`SELECT s.id,s.owner,s.readers FROM ${this.db.schema}.scenarios s
        LEFT JOIN ${this.db.schema}.scenario_sessions session ON session.id=s.session_id
        WHERE (s.expires_at<=now() OR session.closed_at IS NOT NULL OR session.expires_at<=now())
        AND ($1::uuid IS NULL OR s.session_id=$1) AND ($2::text IS NULL OR s.owner=$2)
        ORDER BY s.id FOR UPDATE OF s SKIP LOCKED LIMIT 500`,[sessionId??null,owner??null],client)).rows;
      const ids=rows.map(row=>row.id);
      const owned = new Map<string, string[]>(), metadata = new Map<string, string[]>();
      for (const row of rows) {
        owned.set(row.owner, [...(owned.get(row.owner) ?? []), row.id]);
        for (const recipient of new Set([row.owner, ...row.readers])) metadata.set(recipient, [...(metadata.get(recipient) ?? []), row.id]);
      }
      for (const [recipient, scenarios] of metadata) await removeScenarioMetadata(this.db, recipient, scenarios, client);
      for (const [owner, scenarios] of owned) await this.db.withTransactionOwner(client, owner, async () => {
        for (const table of ['scenario_actions','scenario_links','scenario_objects']) {
          await this.db.query(`DELETE FROM ${this.db.schema}.${table} WHERE owner=$1 AND scenario_id=ANY($2::uuid[])`, [owner, scenarios], client);
        }
      });
      await this.db.query(`DELETE FROM ${this.db.schema}.scenarios WHERE id=ANY($1::uuid[])`, [ids], client);
      await this.db.query(`DELETE FROM ${this.db.schema}.scenario_sessions session WHERE (closed_at IS NOT NULL OR expires_at<=now())
        AND NOT EXISTS(SELECT 1 FROM ${this.db.schema}.scenarios s WHERE s.session_id=session.id)`,[],client);
      return {deleted:ids.length,more:ids.length===500};
    });
  }
  async share(access: Access, model: PublishedOntology, id: string, revision: number, readers: string[]) {
    z.uuid().parse(id);z.number().int().positive().parse(revision);
    const shared=z.array(z.string().min(1).max(200)).max(100).parse(readers);
    return this.db.transaction(async client=>{
      await access.refresh(client);await lockEdits(this.db,model,access.principal.owner,client);
      await scenarioMetadataRead(new Objects(this.db,model,access,client),{type:'OntologyScenario',id});
      const previous = (await this.db.query<{readers:string[]}>(`SELECT readers FROM ${this.db.schema}.scenarios WHERE id=$1 AND owner=$2 FOR UPDATE`, [id, access.principal.owner], client)).rows[0];
      const row=(await this.db.query(`UPDATE ${this.db.schema}.scenarios SET readers=$4,revision=revision+1
        WHERE id=$1 AND owner=$2 AND revision=$3 AND release=$5 AND kind='persisted' AND state='open' AND expires_at>now()
        RETURNING id,revision`,[id,access.principal.owner,revision,JSON.stringify([...new Set(shared)]),model.release],client)).rows[0];
      if(!row)throw new Conflict('Scenario is unavailable or its revision changed');
      await syncScenarioMetadata(this.db,model,id,client,previous?.readers);
      await access.refresh(client);
      return {id:String(row.id),revision:Number(row.revision),readers:[...new Set(shared)]};
    });
  }
  async inviteReviewers(access: Access, model: PublishedOntology, id: string, revision: number, reviewers: string[], existing?: Sql) {
    z.number().int().positive().parse(revision);
    const owner = access.principal.owner;
    const allowed = [...new Set(z.array(z.string().min(1).max(200)).max(100).parse(reviewers))].sort();
    if (allowed.includes(owner)) throw new Conflict('Scenario reviewers must be separate identities');
    const invite = async (client: Sql) => {
      await access.refresh(client);
      access.require(model.document.id, 'view_definition', model.document.id);
      await lockEdits(this.db, model, owner, client);
      const view = await this.view(access, model, id, client);
      await checkScenario(this.db, view, owner, client, true);
      const result = await this.db.query(`UPDATE ${this.db.schema}.scenarios SET reviewers=$4,revision=revision+1
        WHERE id=$1 AND owner=$2 AND revision=$3 AND kind='persisted' AND workflow_run_id IS NULL RETURNING revision`, [id, owner, revision, JSON.stringify(allowed)], client);
      if (!result.rowCount) throw new Conflict('Scenario revision changed or proposal is temporary');
      await syncScenarioMetadata(this.db, model, id, client);
      await access.refresh(client);
      return { id, revision: Number(result.rows[0]!.revision), reviewers: allowed };
    };
    return existing ? invite(existing) : this.db.transaction(invite);
  }
  async pendingReviews(access: Access, model: PublishedOntology, page: number) {
    const reviewer = access.principal.owner;
    access.require(model.document.id, 'view_definition', model.document.id);
    const limit = 20;
    const candidates = (await this.db.query<{ id: string }>(
      `SELECT scenario.id FROM ${this.db.schema}.scenarios scenario
        WHERE scenario.release=$1 AND scenario.reviewers ? $2 AND scenario.kind='persisted'
          AND scenario.state='open' AND scenario.expires_at>clock_timestamp()
          AND (scenario.workflow_run_id IS NULL OR EXISTS (
            SELECT 1 FROM ${this.db.schema}.workflow_runs run
            WHERE run.id=scenario.workflow_run_id AND run.state='waiting-approval'))
        ORDER BY scenario.expires_at,scenario.id LIMIT $3 OFFSET $4`,
      [model.release, reviewer, limit + 1, (page - 1) * limit],
    )).rows;
    const items = [];
    for (const { id } of candidates.slice(0, limit)) {
      try {
        const review = await this.db.transaction(async client => {
          const row = await this.lockReview(access, model, id, client);
          const { name, revision, conflicts, evidenceChanged, snapshot } = await this.reviewDiff(model, row, reviewer, client);
          const approval = await this.db.withTransactionOwner(client, row.owner, () => this.db.query(
            `SELECT 1 FROM ${this.db.schema}.scenario_approvals
              WHERE owner=$1 AND scenario_id=$2 AND revision=$3 AND reviewer=$4 AND snapshot=$5`,
            [row.owner, id, revision, reviewer, snapshot], client,
          ));
          return { id, name, revision, conflicts, evidenceChanged, approved: !conflicts && Boolean(approval.rowCount) };
        });
        items.push(review);
      } catch (error) {
        if (!(error instanceof PermissionDenied) && !(error instanceof NotFound)) throw error;
      }
    }
    return { items, ...(candidates.length > limit && page < 1000 ? { nextPage: page + 1 } : {}) };
  }
  async inspectReview(access: Access, model: PublishedOntology, id: string) {
    return this.db.transaction(async client => {
      const row = await this.lockReview(access, model, id, client);
      const review = await this.reviewDiff(model, row, access.principal.owner, client);
      if (!this.decisions) return review;
      const decisionMemory = await this.db.withTransactionOwner(client, row.owner, async () =>
        this.decisions?.inspect({ model, owner: row.owner, reviewer: access, client, review }));
      await access.refresh(client);
      return { ...review, ...(decisionMemory ? { decisionMemory } : {}) };
    });
  }
  async approveReview(access: Access, model: PublishedOntology, id: string, revision: number, snapshot: string, decision?: ScenarioDecision) {
    return this.db.transaction(async client => {
      const row = await this.lockReview(access, model, id, client);
      const review = await this.reviewDiff(model, row, access.principal.owner, client);
      if (review.revision !== revision || review.snapshot !== snapshot || review.conflicts) {
        throw new Conflict('Scenario review changed or has conflicts');
      }
      const reviewer = access.principal.owner;
      const inserted = await this.db.withTransactionOwner(client, row.owner, () => this.db.query<{ approved_at: Date }>(
        `INSERT INTO ${this.db.schema}.scenario_approvals(scenario_id,owner,revision,reviewer,snapshot) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(scenario_id,revision,reviewer) DO UPDATE SET snapshot=excluded.snapshot,approved_at=clock_timestamp()
          WHERE scenario_approvals.snapshot IS DISTINCT FROM excluded.snapshot RETURNING approved_at`,
        [id, row.owner, revision, reviewer, snapshot], client,
      ));
      if (decision) {
        if (!this.decisions) throw new Conflict('Decision capture is unavailable for this review');
        const support = this.decisions;
        await this.db.withTransactionOwner(client, row.owner, () => support.capture(
          { model, owner: row.owner, reviewer: access, client, review }, decision, inserted.rows[0]?.approved_at));
      }
      if (inserted.rowCount) await appendTrace(this.db, {
        owner: row.owner, release: model.release, projection: model.projection, scenarioId: id,
      }, { kind: 'approval', revision, snapshot, reviewer }, client);
      await access.refresh(client);
      return { id, revision, reviewer: access.principal.owner, approved: true as const };
    });
  }
  private async lockReview(access: Access, model: PublishedOntology, id: string, client: Sql) {
    z.uuid().parse(id);
    await access.refresh(client);
    access.require(model.document.id, 'view_definition', model.document.id);
    const values = [id, model.release, access.principal.owner];
    const lookup = `SELECT id,owner,name,revision,reviewers,journal_steps,workflow_run_id FROM ${this.db.schema}.scenarios
      WHERE id=$1 AND release=$2 AND reviewers ? $3 AND kind='persisted' AND state='open' AND expires_at>clock_timestamp()
      AND (workflow_run_id IS NULL OR EXISTS (
        SELECT 1 FROM ${this.db.schema}.workflow_runs run
        WHERE run.id=workflow_run_id AND run.state='waiting-approval'))`;
    const offered = (await this.db.query<ReviewableScenario>(lookup, values, client)).rows[0];
    if (!offered) throw new NotFound('Scenario review is unavailable');
    await lockEdits(this.db, model, offered.owner, client);
    const row = (await this.db.query<ReviewableScenario>(lookup + ' FOR UPDATE', values, client)).rows[0];
    if (!row) throw new NotFound('Scenario review is unavailable');
    return row;
  }
  private async reviewDiff(model: PublishedOntology, row: ReviewableScenario, reviewer: string, client: Sql, verifyEvidence = true) {
    return this.db.withTransactionOwner(client, row.owner, async () => {
      const author = await Access.load(this.db, { owner: row.owner, scopes: [] }, client);
      const approver = await Access.load(this.db, { owner: reviewer, scopes: [] }, client);
      const check = (type: string, properties: Properties, fields: readonly string[] = []) => {
        for (const access of [author, approver]) {
          access.readRow(model, type, properties);
          if (fields.some(field => !access.cell(model, type, field, properties))) {
            throw new PermissionDenied('Scenario review requires access to each edited property');
          }
        }
      };
      const current = async (ref: ObjectRef) => (await this.db.query<{ revision: string; properties: Properties }>(
        `SELECT revision,properties FROM ${this.db.schema}.objects WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`,
        [model.projection, row.owner, ref.type, ref.id], client,
      )).rows[0];
      const changes = await this.changes(row.owner, row.id, client);
      const objects = [];
      for (const item of changes.objects) {
        const ref = { type: item.type, id: item.id }, live = await current(ref), fields = editedFields(item);
        if (live) check(ref.type, live.properties);
        const visible = (properties: Properties | null) => {
          if (!properties) return null;
          check(ref.type, properties, fields);
          return Object.fromEntries(fields.filter(field => Object.hasOwn(properties, field)).map(field => [field, properties[field]]));
        };
        const conflict = objectConflict(item, live, row.journal_steps > 0)
          || item.properties === null && digest(await objectLinks(this.db, model, row.owner, ref, client)) !== digest(item.base_links);
        objects.push({ ref, before: visible(item.base_properties), after: visible(item.properties), editedFields: fields, conflict });
      }
      const links = [], staged = new Map(changes.objects.map(item => [digest({ type: item.type, id: item.id }), item.properties]));
      for (const item of changes.links) {
        for (const access of [author, approver]) access.definition(model, 'link', item.type);
        const from = { type: String(item.from_type), id: String(item.from_id) }, to = { type: String(item.to_type), id: String(item.to_id) };
        for (const ref of [from, to]) {
          const live = await current(ref);
          const proposed = staged.get(digest(ref));
          if (!live && !proposed) throw new NotFound('Scenario review endpoint is unavailable');
          if (live) check(ref.type, live.properties);
          if (proposed) check(ref.type, proposed);
        }
        links.push({ type: String(item.type), from, to, removed: Boolean(item.removed), conflict: await this.linkConflict(model, row.owner, item, client) });
      }
      await author.refresh(client);
      await approver.refresh(client);
      const revision = Number(row.revision);
      let commit, evidenceVersion: string | undefined;
      let evidenceChanged = false;
      const evidence: { ref: ObjectRef; revision: number }[] = [];
      const steps = row.journal_steps ? await this.steps(row.owner, row.id, client) : [];
      if (row.workflow_run_id) {
        const run = (await this.db.query(
          `SELECT run.body->'proposal' AS proposal,run.object_ref,task.id AS task_id,task.scopes,
            task.cognitive_context,task.cognitive_evidence,task.result_permissions FROM ${this.db.schema}.workflow_runs run
            JOIN ${this.db.schema}.tasks task ON task.id=run.proposal_task AND task.owner=run.owner
            WHERE run.id=$1 AND run.owner=$2 AND run.proposal_scenario=$3 AND run.state='waiting-approval'`,
          [row.workflow_run_id, row.owner, row.id], client,
        )).rows[0];
        if (!run) throw new NotFound('Scenario review is unavailable');
        const object = objectRefSchema.parse(run.object_ref), data = await current(object);
        if (!data) throw new NotFound('Workflow input is unavailable');
        check(object.type, data.properties);
        commit = workflowMerge(model, cognitiveStepSchema.parse(run.proposal), object, row.id, revision);
        const context = cognitiveContextSchema.parse(run.cognitive_context);
        const observations = context.evidenceVersion ? undefined : recordedDecisionEvidence(run.cognitive_evidence);
        evidenceVersion = context.evidenceVersion ?? digest({ release: model.release, scenarioId: row.id, observations });
        if (verifyEvidence) {
          if (observations) {
            const evidenceAccess = await Access.load(this.db, { owner: row.owner, scopes: run.scopes }, client);
            const view = await this.view(evidenceAccess, model, row.id, client);
            const checkpoint = this.decisionCheckpoint(model, row.id, run.task_id, observations, evidenceAccess);
            await this.lockDecisionSets(model, row.owner, observations, client);
            try {
              await this.withReplay(view, row, evidenceAccess, client, async prefix => {
                await this.replayJournal(prefix, steps, checkpoint.check);
              });
              checkpoint.assertComplete();
            } catch (error) {
              if (!(error instanceof Conflict || error instanceof NotFound || error instanceof PermissionDenied)) throw error;
              evidenceChanged = true;
            }
          } else evidenceChanged = await decisionVersion(this.db, model, row.owner, client) !== evidenceVersion;
        }
        for (const access of [author, approver]) access.definition(model, 'action', commit.action);
        const draftRows = (await this.db.query<{ type: string; id: string }>(
          `SELECT type,id FROM ${this.db.schema}.scenario_objects WHERE owner=$1 AND scenario_id=$2`,
          [row.owner, row.id], client,
        )).rows;
        const draftKeys = new Set(draftRows.map(digest));
        const refs = new Map<string, { ref: ObjectRef; revision?: number }>();
        if (observations) {
          for (const item of observations) for (const fact of item.refs) {
            const key = digest(fact.ref);
            if (fact.ref.type !== 'OntologyScenario' && !draftKeys.has(key) && !refs.has(key)) refs.set(key, fact);
          }
        } else {
          const requirements: Requirement[] = [
            ...steps.flatMap(step => step.requirements), ...(run.result_permissions ?? []),
          ];
          for (const { row: dependency } of requirements) {
            if (!dependency || dependency.projection !== model.projection || dependency.type === 'OntologyScenario') continue;
            const ref = { type: dependency.type, id: dependency.id }, key = digest(ref);
            if (!draftKeys.has(key)) refs.set(key, { ref });
          }
        }
        for (const { ref, revision } of [...refs.values()].sort((a, b) =>
          a.ref.type.localeCompare(b.ref.type) || a.ref.id.localeCompare(b.ref.id))) {
          const data = await current(ref);
          if (!data) {
            evidenceChanged = true;
            continue;
          }
          check(ref.type, data.properties);
          evidence.push({ ref, revision: revision ?? Number(data.revision) });
        }
        await author.refresh(client);
        await approver.refresh(client);
      }
      const version = { id: row.id, revision, objects, links, ...(commit ? { commit, evidence, evidenceVersion, evidenceChanged } : {}) };
      const journal = row.journal_steps ? digest(steps) : undefined;
      return { ...version, name: row.name, conflicts: evidenceChanged || [...objects, ...links].some(change => change.conflict),
        snapshot: digest({ ...version, release: model.release, reviewer, journal }) };
    });
  }
  async list(access: Access, model: PublishedOntology, cursor?: string) {
    if(cursor)z.uuid().parse(cursor);
    access.require(model.document.id, 'view_definition', model.document.id);
    const rows=(await this.db.query(`SELECT s.id,s.name,s.revision,s.state,s.expires_at FROM ${this.db.schema}.scenarios s
      LEFT JOIN ${this.db.schema}.scenario_sessions session ON session.id=s.session_id
      WHERE s.owner=$1 AND s.release=$2 AND s.state='open' AND s.expires_at>now()
      AND (s.session_id IS NULL OR (session.closed_at IS NULL AND session.expires_at>now()))
      AND ($3::uuid IS NULL OR s.id>$3) ORDER BY s.id LIMIT 101`, [access.principal.owner, model.release,cursor??null])).rows;
    return {items:rows.slice(0,100).map(row=>({id:String(row.id),name:String(row.name),revision:Number(row.revision),state:String(row.state),expiresAt:row.expires_at as Date,expires_at:row.expires_at as Date})),cursor:rows.length>100?String(rows[99]!.id):undefined};
  }
  async create(access: Access, model: PublishedOntology, raw: unknown, beforeCommit?: (client: Sql) => Promise<void>,
    context?: { client: Sql; runId: string; reviewers: string[] } | { client: Sql }) {
    const workflow = context && 'runId' in context ? context : undefined;
    const input = createScenarioSchema.parse(raw), owner = access.principal.owner;
    if(model.evaluation&&(input.kind!=='temporary'||context?.client!==model.evaluation.client))
      throw new Conflict('Prepared candidates only allow temporary evaluation Scenarios');
    access.require(model.document.id, 'view_definition', model.document.id);
    const create = async (client: Sql) => {
      await beforeCommit?.(client);
      await lockEdits(this.db, model, owner, client);
      let sessionExpires:Date|null=null;
      if(input.sessionId){
        const session=(await this.db.query(`SELECT expires_at FROM ${this.db.schema}.scenario_sessions WHERE id=$1 AND owner=$2 AND closed_at IS NULL AND expires_at>now() FOR UPDATE`,[input.sessionId,owner],client)).rows[0];
        if(!session)throw new Conflict('Scenario session is closed or unavailable');
        sessionExpires=session.expires_at;
      }
      const creation=digest({...input,release:model.release,...(workflow ? { workflow: workflow.runId } : {})});
      // Automatic sync rebases as the creator, from the commit the Scenario starts at.
      const creator={owner,scopes:[...access.principal.scopes],...(access.principal.memberAccess?{memberAccess:true}:{})};
      await this.db.query(`INSERT INTO ${this.db.schema}.scenarios(id,owner,request_id,name,release,kind,description,session_id,expires_at,creation_digest,workflow_run_id,reviewers,principal,sync_position)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,LEAST(now()+$9*interval '1 second',$10::timestamptz),$11,$12,$13,$14,(SELECT coalesce(max(commit_seq),0) FROM ${this.db.schema}.change_commits WHERE owner=$2)) ON CONFLICT(owner,request_id) DO NOTHING`,
        [randomUUID(),owner,input.requestId,input.name,model.release,input.kind,input.description,input.sessionId??null,input.ttlSeconds??31*86400,sessionExpires,creation,workflow?.runId ?? null,JSON.stringify(workflow?.reviewers ?? []),creator],client);
      const row = (await this.db.query(`SELECT id,name,release,revision,state,expires_at,kind,description,creation_digest FROM ${this.db.schema}.scenarios WHERE owner=$1 AND request_id=$2`, [owner, input.requestId], client)).rows[0]!;
      if (row.creation_digest?row.creation_digest!==creation:row.name !== input.name || row.release !== model.release) throw new Conflict('Scenario request ID already has different input');
      await syncScenarioMetadata(this.db,model,String(row.id),client);
      await access.refresh(client); await beforeCommit?.(client);
      return {id:String(row.id),name:String(row.name),release:String(row.release),revision:Number(row.revision),state:String(row.state),expiresAt:row.expires_at as Date,expires_at:row.expires_at as Date,kind:String(row.kind),description:String(row.description)};
    };
    return context ? create(context.client) : this.db.transaction(create);
  }
  async view(access: Access, model: PublishedOntology, id: string, client: Sql = this.db.pool) {
    z.uuid().parse(id);
    const view = model.scoped(id, model.evaluation);
    await checkScenario(this.db, view, access.principal.owner, client);
    if (model.evaluation) await lockEdits(this.db,view,access.principal.owner,client);
    else if ((await this.db.query(`SELECT release FROM ${this.db.schema}.ontology WHERE id=$1`, [model.document.id], client)).rows[0]?.release !== model.release) throw new Conflict('Scenario publication changed; create a new scenario');
    return view;
  }
  private async continuationRows(access: Access, model: PublishedOntology, client: Sql, id?: string, lock = false) {
    return (await this.db.query<ContinuationRow>(`WITH RECURSIVE releases AS (
      SELECT digest,prepared_from FROM ${this.db.schema}.releases WHERE digest=$1
      UNION ALL SELECT r.digest,r.prepared_from FROM ${this.db.schema}.releases r JOIN releases parent ON r.digest=parent.prepared_from
    ) SELECT s.*,
      (SELECT count(*)::int FROM ${this.db.schema}.scenario_actions a WHERE a.scenario_id=s.id AND a.owner=s.owner) AS action_count,
      (SELECT count(*)::int FROM ${this.db.schema}.scenario_actions a WHERE a.scenario_id=s.id AND a.owner=s.owner
        AND a.step_revision IS NOT NULL AND jsonb_typeof(a.input)='object' AND jsonb_typeof(a.edits)='array') AS complete_actions,
      (EXISTS(SELECT 1 FROM ${this.db.schema}.scenario_objects d WHERE d.scenario_id=s.id AND d.owner=s.owner
        AND (d.properties IS DISTINCT FROM d.base_properties OR (d.properties IS NOT NULL AND jsonb_array_length(d.edited_fields)>0)))
       OR EXISTS(SELECT 1 FROM ${this.db.schema}.scenario_links d WHERE d.scenario_id=s.id AND d.owner=s.owner
        AND (NOT d.removed) IS DISTINCT FROM d.base_present)) AS has_changes
      FROM ${this.db.schema}.scenarios s JOIN releases r ON r.digest=s.release
      LEFT JOIN ${this.db.schema}.scenario_sessions session ON session.id=s.session_id
      WHERE s.owner=$2 AND ($3::uuid IS NULL OR s.id=$3) AND s.state='open' AND s.workflow_run_id IS NULL
        AND (s.release<>$1 OR s.kind='temporary') AND s.expires_at>now()
        AND (s.session_id IS NULL OR (session.closed_at IS NULL AND session.expires_at>now()))
      ORDER BY s.expires_at DESC,s.id LIMIT 100 ${lock ? 'FOR UPDATE OF s' : ''}`,
      [model.release,access.principal.owner,id??null],client)).rows;
  }

  private continuationStatus(row: {journal_steps: number; action_count: number; complete_actions: number; has_changes: boolean}) {
    return row.action_count === row.journal_steps && row.complete_actions === row.action_count
      && (row.action_count > 0 || !row.has_changes)
      ? { status: 'ready' as const, reason: null }
      : { status: 'blocked' as const, reason: 'incomplete-action-journal' as const };
  }

  async continuationSources(access: Access, model: PublishedOntology) {
    return this.db.withOwner(access.principal.owner, async () => {
      await access.refresh(); access.require(model.document.id,'view_definition',model.document.id);
      const rows = await this.continuationRows(access,model,this.db.pool);
      await access.refresh();
      return {items:rows.map(row=>({id:String(row.id),name:String(row.name),kind:String(row.kind),release:String(row.release),
        revision:Number(row.revision),expiresAt:row.expires_at as Date,continuation:this.continuationStatus(row)}))};
    });
  }

  /** Recovery displays historical differences using today's schema and permissions; it performs no edits. */
  async inspectContinuation(access: Access, model: PublishedOntology, id: string, revision: number) {
    z.uuid().parse(id); z.number().int().positive().parse(revision);
    return this.db.withOwner(access.principal.owner,()=>this.db.transaction(async client=>{
      await access.refresh(); access.require(model.document.id,'view_definition',model.document.id);
      await lockEdits(this.db,model,access.principal.owner,client);
      const [row]=await this.continuationRows(access,model,client,id,true);
      if(!row || Number(row.revision)!==revision)throw new Conflict('Continuation source changed or is unavailable');
      const changes=await this.changes(access.principal.owner,id,client),graph=new Objects(this.db,model,access,client);
      const mask=(ref:ObjectRef,values:Properties|null)=>{
        if(!values)return null;
        const visible=access.maskHistoricalSnapshot(model,ref.type,values);
        if(!visible)throw new NotFound('Scenario recovery data is unavailable');
        return visible;
      };
      const current=async(ref:ObjectRef)=>{
        access.read(model,ref.type);
        const live=(await this.db.query<LiveObject>(`SELECT revision,properties FROM ${this.db.schema}.objects
          WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`,[model.projection,access.principal.owner,ref.type,ref.id],client)).rows[0];
        if(live&&!graph.maskSnapshot(ref,live.properties))throw new NotFound('Scenario recovery data is unavailable');
        return live;
      };
      const objects=[];
      for(const item of changes.objects){
        const ref={type:item.type,id:item.id}; await current(ref);
        objects.push({ref,before:mask(ref,item.base_properties),after:mask(ref,item.properties)});
      }
      const endpoint=async(ref:ObjectRef)=>{
        if(await current(ref))return;
        const edit=changes.objects.find(item=>item.type===ref.type&&item.id===ref.id);
        if(!edit||!mask(ref,edit.properties??edit.base_properties))throw new NotFound('Scenario recovery endpoint is unavailable');
      };
      const links=[];
      for(const item of changes.links){
        access.definition(model,'link',item.type);
        const definition=model.links.get(item.type);
        if(!definition||definition.from.type!==item.from_type||definition.to.type!==item.to_type)
          throw new Conflict('Scenario recovery relationship is no longer published');
        const from={type:item.from_type,id:item.from_id},to={type:item.to_type,id:item.to_id};
        await endpoint(from);await endpoint(to);
        links.push({type:item.type,from,to,removed:item.removed});
      }
      await access.refresh(client);
      return {id:String(row.id),revision:Number(row.revision),name:String(row.name),release:String(row.release),
        continuation:this.continuationStatus(row),objects,links};
    }));
  }

  async continueScenario(access:Access,model:PublishedOntology,raw:unknown) {
    const input=continueScenarioSchema.parse(raw), owner=access.principal.owner;
    return this.db.withOwner(owner,()=>this.db.transaction(async client=>{
      await access.refresh(client);
      access.require(model.document.id,'view_definition',model.document.id);
      await lockEdits(this.db,model,owner,client);
      const [source]=await this.continuationRows(access,model,client,input.id,true);
      if(!source||Number(source.revision)!==input.revision)throw new Conflict('Continuation source changed or is unavailable');
      const previous=await new Metadata(this.db).get(source.release,client);
      const changes=await this.changes(owner,source.id,client), steps=await this.steps(owner,source.id,client);
      if(this.continuationStatus(source).status==='blocked')
        throw new Conflict('Scenario continuation requires a complete Action journal');
      const name=source.name.slice(0,190)+' (continued)';
      const next=await this.create(access,model,{requestId:input.requestId,name,
        description:`Continued from ${source.id} revision ${input.revision}. Previous approvals do not transfer.`},undefined,{client});
      // The creation digest binds both the source revision and the target publication.
      if(next.revision>1)return {id:next.id,revision:next.revision,source:source.id,release:model.release};
      const view=await this.view(access,model,next.id,client);
      for(const item of changes.objects){
        access.read(model,item.type);
        for(const snapshot of [item.base_properties,item.properties])if(snapshot){
          access.readRow(model,item.type,snapshot);
          for(const field of editedFields(item))if(Object.hasOwn(snapshot,field)&&!access.cell(model,item.type,field,snapshot))
            throw new PermissionDenied('Scenario evidence field is unavailable');
        }
        const live=(await this.db.query<LiveObject>(`SELECT revision,properties FROM ${this.db.schema}.objects
          WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`,[model.projection,owner,item.type,item.id],client)).rows[0];
        if(objectConflict(item,live,true)||item.properties===null&&digest(await objectLinks(this.db,model,owner,{type:item.type,id:item.id},client))!==digest(item.base_links))
          throw new Conflict('Continuation conflicts with current object data or relationships');
      }
      for(const step of steps){
        if(step.digest!==digest({release:previous.release,action:step.action,input:step.input}))
          throw new Conflict('Action journal fingerprint changed');
        const prior=previous.actions.get(step.action), action=model.actions.get(step.action);
        if(!prior||!action||digest(prior)!==digest(action))throw new Conflict('Action contract changed; propose the step again');
        for(const name of [...(action.function?[action.function]:[]),...action.submissionCriteria.map(item=>item.function)]){
          if(!model.functions.has(name)||digest(previous.functions.get(name))!==digest(model.functions.get(name))
            ||previous.bindings.functions[name]!==model.bindings.functions[name])
            throw new Conflict('Action Function binding changed; propose the step again');
        }
        access.action(model,step.action);
        for(const requirement of step.requirements){
          if(!access.allows(requirement)) throw new PermissionDenied('Scenario evidence permissions changed');
          access.require(requirement.ontology,requirement.permission,requirement.resource);
        }
        const edits:ScenarioMutation[]=[];
        const graph=new Objects(this.db,view,access,client,{action:step.action,requestId:step.request_id,scenarioEdits:edits});
        const live = new Objects(this.db, model, access, client);
        const created = new Set(step.edits!.flatMap(edit => edit.op === 'create' ? [digest(edit.ref)] : []));
        const deferred = new Map<string, NonNullable<Requirement['row']>[]>();
        const checkRow = async (reader: Objects, row: NonNullable<Requirement['row']>) => {
          const ref = { type: row.type, id: row.id };
          await reader.read(ref);
          for (const field of row.fields) {
            if (!await reader.propertyVisible(ref, field)) throw new PermissionDenied('Scenario evidence field is unavailable');
          }
        };
        const checkCreated = async (key: string) => {
          for (const row of deferred.get(key) ?? []) await checkRow(graph, row);
          deferred.delete(key);
        };
        for (const { row } of step.requirements) {
          if (!row) continue;
          if (row.scenario && row.scenario !== source.id) throw new Conflict('Scenario depends on a different draft');
          const key = digest({ type: row.type, id: row.id });
          if (row.scenario && created.has(key)) {
            // The Action can read its own new objects while creating relationships.
            const requirements = deferred.get(key) ?? [];
            requirements.push(row);
            deferred.set(key, requirements);
          } else {
            await checkRow(row.scenario ? graph : live, row);
          }
        }
        for (const edit of step.edits!) {
          if (edit.op === 'delete') await checkCreated(digest(edit.ref));
          await this.applyProposedEdit(graph, edit);
        }
        for (const key of deferred.keys()) await checkCreated(key);
        await recordScenarioAction(graph,step.action,step.input!,step.result,step.request_id);
      }
      const replayed=await this.changes(owner,next.id,client);
      if(this.footprint(changes)!==this.footprint(replayed))throw new Conflict('Scenario replay changed the proposed differences');
      for(const link of replayed.links)if(await this.linkConflict(model,owner,link,client))
        throw new Conflict('Continuation conflicts with current links');
      let current=await this.inspect(access,model,next.id,client);
      if(source.reviewers?.length){
        const review=await this.inviteReviewers(access,model,next.id,current.revision,source.reviewers,client);
        current={...current,revision:review.revision};
      }
      await access.refresh(client);
      return {id:next.id,revision:current.revision,source:source.id,release:model.release};
    }));
  }

  private async changedLinks(owner: string, id: string, client: Sql) {
    return (await this.db.query(`SELECT * FROM ${this.db.schema}.scenario_links
      WHERE owner=$1 AND scenario_id=$2 AND (NOT removed) IS DISTINCT FROM base_present ORDER BY type,from_id,to_id`,
    [owner, id], client)).rows;
  }

  /** Compare staged rows with one snapshot of their live objects. Deleted objects carry bounded, ordered link snapshots. */
  private async objectChangesWithLive(model: PublishedOntology, owner: string, id: string, client: Sql) {
    const s = this.db.schema;
    return (await this.db.query<ScenarioObjectEdit & {
      live_revision: string | null; live_properties: Properties | null; live_links: unknown[] | null;
    }>(`SELECT d.*,o.revision AS live_revision,o.properties AS live_properties,
      CASE WHEN d.properties IS NULL THEN (
        SELECT coalesce(jsonb_agg(edge ORDER BY edge.type,edge.from_type,edge.from_id,edge.to_type,edge.to_id),'[]'::jsonb)
        FROM (
          SELECT type,from_type,from_id,to_type,to_id FROM ${s}.links
            WHERE projection=$3 AND owner=$1 AND from_type=d.type AND from_id=d.id
          UNION SELECT type,from_type,from_id,to_type,to_id FROM ${s}.links
            WHERE projection=$3 AND owner=$1 AND to_type=d.type AND to_id=d.id
          ORDER BY type,from_type,from_id,to_type,to_id LIMIT 10001
        ) edge
      ) END AS live_links
      FROM ${s}.scenario_objects d LEFT JOIN ${s}.objects o
        ON o.projection=$3 AND o.owner=d.owner AND o.type=d.type AND o.id=d.id
      WHERE d.owner=$1 AND d.scenario_id=$2
        AND (d.properties IS DISTINCT FROM d.base_properties OR (d.properties IS NOT NULL AND jsonb_array_length(d.edited_fields)>0))
      ORDER BY d.type,d.id`, [owner,id,model.projection], client)).rows;
  }

  private async changes(owner: string, id: string, client: Sql) {
    const objects = (await this.db.query<ScenarioObjectEdit>(`SELECT * FROM ${this.db.schema}.scenario_objects WHERE owner=$1 AND scenario_id=$2
      AND (properties IS DISTINCT FROM base_properties OR (properties IS NOT NULL AND jsonb_array_length(edited_fields) > 0))
      ORDER BY type,id`, [owner, id], client)).rows;
    const links = await this.changedLinks(owner, id, client);
    return { objects, links };
  }
  private async steps(owner: string, id: string, client: Sql) {
    return (await this.db.query<ScenarioStep>(
      `SELECT action,request_id,digest,result,input,requirements,step_revision,edits FROM ${this.db.schema}.scenario_actions
      WHERE owner=$1 AND scenario_id=$2 ORDER BY step_revision NULLS FIRST,request_id`, [owner, id], client,
    )).rows;
  }
  async evaluationFootprint(owner:string,id:string,client:Sql){
    return this.footprint(await this.changes(owner,id,client));
  }
  private footprint({ objects, links }: Awaited<ReturnType<Scenarios['changes']>>) {
    return digest({
      objects: objects.map(item => {
        const fields = editedFields(item);
        const values = (properties: Properties | null) => properties &&
          Object.fromEntries(fields.filter(field => Object.hasOwn(properties, field)).map(field => [field, properties[field]]));
        return [item.type, item.id, fields, values(item.base_properties), values(item.properties)];
      }),
      links: links.map(item => [item.type, item.from_type, item.from_id, item.to_type, item.to_id, item.base_present, item.removed]),
    });
  }
  private async applyProposedEdit(prefix: Objects, edit: ScenarioMutation) {
    switch (edit.op) {
      case 'create':
        return prefix.create(edit.ref, Object.fromEntries(edit.fields.map(field => [field, edit.values[field]])));
      case 'edit':
        return prefix.edit(edit.ref, (await prefix.readStored(edit.ref)).revision,
          Object.fromEntries(edit.fields.map(field => [field, edit.values[field]])));
      case 'delete':
        return prefix.remove(edit.ref, (await prefix.readStored(edit.ref)).revision);
      case 'link':
        return prefix.link(edit.edge);
      case 'unlink':
        return prefix.unlink(edit.edge);
      default:
        throw new Conflict('Scenario has an unavailable staged edit');
    }
  }
  private async validateSteps(graph: Objects, view: PublishedOntology, row: ReviewableScenario, steps: ScenarioStep[],
    reviewed: Awaited<ReturnType<Scenarios['changes']>>, validateFinal: (candidate: Objects) => Promise<void>,
    validateAction?: ValidateAction, checkpoint?: DecisionCheckpoint) {
    if (steps.filter(step => step.step_revision !== null).length !== row.journal_steps ||
        steps.some(step => (step.step_revision === null) !== (step.edits === null))) {
      throw new Conflict('Scenario needs a new proposal with a complete Action journal');
    }
    if (!row.journal_steps) {
      const guarded = steps.filter(step => graph.model.action(step.action).submissionCriteria.length);
      if (guarded.length) {
        const [step] = guarded;
        if (steps.length !== 1 || !step?.input || !validateAction)
          throw new Conflict('Scenario needs a new proposal with revalidatable Action submissions');
        await validateAction(graph, step.action, step.input);
      }
      return validateFinal(new Objects(this.db, view, graph.access, graph.client));
    }
    if (steps.length !== row.journal_steps)
      throw new Conflict('Scenario needs a new proposal with a complete Action journal');

    const { client, access } = graph;
    const replayAccess = await Access.load(this.db, access.principal, client);
    await this.withReplay(view, row, replayAccess, client, async prefix => {
      await this.replayJournal(prefix, steps, checkpoint, async (step) => {
        const action = graph.model.action(step.action);
        if (validateAction) await validateAction(prefix, step.action, step.input!);
        else if (action.submissionCriteria.length || Object.keys(action.objectParameters).length)
          throw new Conflict('Scenario needs a merge Action that can revalidate its submissions');
      });
      if (this.footprint(await this.changes(graph.owner, row.id, client)) !== this.footprint(reviewed))
        throw new Conflict('Scenario replay differs from the reviewed field or relationship edits; rebase or propose and review again');
      await validateFinal(prefix);
      access.adoptReads(replayAccess);
    });
  }

  private async withReplay(view: PublishedOntology, row: ReviewableScenario, access: Access, client: Sql,
    replay: (prefix: Objects) => Promise<void>) {
    const owner = row.owner;
    await this.db.query('SAVEPOINT scenario_replay', [], client);
    try {
      // Park the original rows inside the savepoint so replay can use the authored Scenario identity.
      // The parking row is expired and disappears on rollback. Existing runtime roles need no DELETE grant.
      const parking = randomUUID();
      await this.db.query(`INSERT INTO ${this.db.schema}.scenarios(id,owner,request_id,name,release,kind,state,expires_at)
        VALUES($1,$2,$3,'Scenario replay storage',$4,'temporary','discarded',now())`, [parking, owner, 'replay:' + parking, view.release], client);
      for (const table of ['scenario_links', 'scenario_objects']) {
        await this.db.query(`UPDATE ${this.db.schema}.${table} SET scenario_id=$3 WHERE owner=$1 AND scenario_id=$2`, [owner, row.id, parking], client);
      }
      await replay(new Objects(this.db, view, access, client));
    } finally {
      await this.db.query('ROLLBACK TO SAVEPOINT scenario_replay', [], client);
      await this.db.query('RELEASE SAVEPOINT scenario_replay', [], client);
    }
  }

  private async replayJournal(prefix: Objects, steps: ScenarioStep[], checkpoint?: DecisionCheckpoint,
    beforeStep?: (step: ScenarioStep) => Promise<void>) {
    for (const [index, step] of steps.entries()) {
      if (step.step_revision === null || !step.input || !Array.isArray(step.edits) ||
          step.digest !== digest({ release: prefix.model.release, action: step.action, input: step.input }))
        throw new Conflict('Scenario has unavailable Action submission evidence');
      await beforeStep?.(step);
      await checkpoint?.(prefix, index, 0);
      for (const [offset, edit] of step.edits.entries()) {
        await this.applyProposedEdit(prefix, edit);
        await checkpoint?.(prefix, index, offset + 1);
      }
    }
    await checkpoint?.(prefix, steps.length, 0);
  }

  private async lockDecisionSets(model: PublishedOntology, owner: string, observations: DecisionObservation[], client: Sql) {
    const ids = [...new Set(observations.flatMap(item => item.savedSets ?? []))];
    if (!ids.length) return;
    // Retain locks on the actual saved definitions after rolling back the replay savepoint.
    await this.db.query(`SELECT id FROM ${this.db.schema}.object_sets
      WHERE ontology=$1 AND id=ANY($2::uuid[]) AND (owner=$3 OR readers ? $3) ORDER BY id FOR SHARE`,
      [model.document.id, ids, owner], client);
  }

  private decisionCheckpoint(model: PublishedOntology, scenarioId: string, taskId: string,
    observations: DecisionObservation[], access: Access) {
    const pending = new Map<string, DecisionObservation[]>();
    for (const observation of observations) {
      const key = observation.step + ':' + observation.offset;
      const group = pending.get(key);
      if (group) group.push(observation);
      else pending.set(key, [observation]);
    }
    const check: DecisionCheckpoint = async (prefix, step, offset) => {
      const key = step + ':' + offset;
      for (const observation of pending.get(key) ?? []) {
        const read = observation.read;
        if (read.kind === 'pa') {
          const response = (await this.db.query(`SELECT response FROM ${this.db.schema}.pa_requests
            WHERE id=$1 AND owner=$2 AND task_id=$3`, [read.requestId, access.principal.owner, taskId], prefix.client)).rows[0]?.response;
          if (response == null || digest(response) !== observation.fingerprint)
            throw new Conflict('Workflow decision evidence changed; start a new proposal');
          continue;
        }
        const graph = new Objects(this.db, observation.view === 'live' ? model : prefix.model, access, prefix.client);
        await replayRead(graph, { scenarioId }, observation, () => {
          switch (read.kind) {
            case 'object': return graph.read(read.ref);
            case 'stored': return graph.readStored(read.ref);
            case 'query': return graph.query(querySchema.parse(read.input));
            case 'follow': return graph.follow(read.ref, read.link, read.as, read.maximum);
            case 'source': return graph.matchesSource(read.ref, read.source);
            case 'set': return new ObjectSets(this.db, read.maximum).evaluate(graph.access, graph.model, read.input, graph.client);
            case 'aggregate': return new ObjectSets(this.db, read.maximum).aggregate(graph.access, graph.model, read.input, graph.client);
          }
        });
      }
      pending.delete(key);
    };
    return { check, assertComplete() {
      if (pending.size) throw new Conflict('Workflow evidence refers to an unavailable Scenario checkpoint');
    } };
  }

  async inspect(access: Access, model: PublishedOntology, id: string, existing?: Sql) {
    const owner = access.principal.owner;
    const inspect = async (client: Sql) => {
      const view = await this.view(access, model, id, client);
      await lockEdits(this.db, model, owner, client); await checkScenario(this.db, view, owner, client, true);
      const row = (await this.db.query(`SELECT id,name,revision,state,expires_at,journal_steps,kind,reviewers,workflow_run_id
        FROM ${this.db.schema}.scenarios WHERE owner=$1 AND id=$2`, [owner, id], client)).rows[0]!;
      const changes = await this.changes(owner, id, client), objects = [];
      for (const item of changes.objects) {
        access.read(model, item.type);
        const mask = (properties: Record<string, unknown> | null, snapshotModel: PublishedOntology) => {
          if (!properties) return null;
          access.readRow(snapshotModel,item.type,properties);
          return new Objects(this.db,snapshotModel,access,client).maskSnapshot({type:item.type,id:item.id},properties);
        };
        const live = (await this.db.query<LiveObject>(`SELECT revision,properties FROM ${this.db.schema}.objects WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`, [model.projection, owner, item.type, item.id], client)).rows[0];
        objects.push({ ref: { type: item.type, id: item.id }, before: mask(item.base_properties, model), after: mask(item.properties, view), editedFields: editedFields(item).filter(field => access.cell(item.properties ? view : model,item.type,field,item.properties ?? item.base_properties ?? {})), conflict: objectConflict(item, live, row.journal_steps > 0) || item.properties===null && digest(await objectLinks(this.db,model,owner,{type:item.type,id:item.id},client))!==digest(item.base_links) });
      }
      const proposed = new Objects(this.db,view,access,client), live = new Objects(this.db,model,access,client);
      const requireEndpoint = async (ref: ObjectRef) => {
        try { await proposed.read(ref); }
        catch (error) {
          if (!(error instanceof NotFound)) throw error;
          // A removed endpoint is absent from the proposed view; its live instance still governs access.
          await live.read(ref);
        }
      };
      const links = [];
      for(const item of changes.links){
        await requireEndpoint({type:item.from_type,id:item.from_id});
        await requireEndpoint({type:item.to_type,id:item.to_id});
        access.definition(model, 'link', item.type);
        const present=(await this.db.query(`SELECT 1 FROM ${this.db.schema}.links WHERE projection=$1 AND owner=$2 AND type=$3 AND from_type=$4 AND from_id=$5 AND to_type=$6 AND to_id=$7`,[model.projection,owner,item.type,item.from_type,item.from_id,item.to_type,item.to_id],client)).rowCount!>0;
        links.push({ type: item.type, from: { type: item.from_type, id: item.from_id }, to: { type: item.to_type, id: item.to_id }, removed: item.removed,conflict:present!==item.base_present || await this.cardinalityConflict(model,owner,item,client) });
      }
      await access.refresh(client);
      return {
        id: String(row.id), name: String(row.name), revision: Number(row.revision), state: String(row.state),
        expiresAt: row.expires_at as Date, objects, links, conflicts: [...objects, ...links].some(item => item.conflict),
        review: {
          reviewers: row.reviewers as string[],
          canInvite: row.kind === 'persisted' && row.workflow_run_id === null,
        },
      };
    };
    return existing ? inspect(existing) : this.db.transaction(inspect);
  }
  /**
   * S1, automatic sync: brings one open persisted Scenario up to the live data, as Palantir rebases a scenario every 10
   * minutes, and reports whether it claimed one. Live commits since the Scenario's last sync that edit one of its staged
   * objects, or change a link of a staged link's type at one of its ends, rebase it as its creator. Other commits only
   * advance its position. A conflict, or a Scenario its publication no longer allows, stops automatic sync and is
   * recorded on the Scenario; an explicit rebase resolves it.
   */
  async syncOne(metadata: Metadata): Promise<boolean> {
    const s = this.db.schema;
    const claimed = await this.db.transaction(async client => {
      const row = (await this.db.query(`SELECT id,owner,release,revision,principal,sync_position::text FROM ${s}.scenarios
        WHERE kind='persisted' AND state='open' AND expires_at>now() AND sync_state='current' AND principal IS NOT NULL
          AND (synced_at IS NULL OR synced_at<=now()-interval '10 minutes')
        ORDER BY synced_at NULLS FIRST, id FOR UPDATE SKIP LOCKED LIMIT 1`, [], client)).rows[0];
      if (row) await this.db.query(`UPDATE ${s}.scenarios SET synced_at=now() WHERE id=$1`, [row.id], client);
      return row as { id: string; owner: string; release: string; revision: string; principal: Principal; sync_position: string | null } | undefined;
    });
    if (!claimed) return false;
    const { id, owner } = claimed;
    const record = (state: string, error: string | null, position?: string) => this.db.query(`UPDATE ${s}.scenarios SET sync_state=$3,sync_error=$4,
      sync_position=coalesce($5::bigint,sync_position) WHERE owner=$1 AND id=$2`, [owner, id, state, error, position ?? null]);
    await this.db.withOwner(owner, async () => {
      const latest = await latestCommit(this.db, owner, this.db.pool);
      const after = claimed.sync_position;
      // A Scenario from before automatic sync has no position, so it is rebased once to find out.
      if (after !== null && BigInt(latest) <= BigInt(after)) return;
      if (after !== null && !(await this.stagedTouched(owner, id, after, latest))) { await record('current', null, latest); return; }
      const model = await metadata.active();
      if (model.release !== claimed.release) { await record('conflict', 'Scenario publication changed; create a new scenario'); return; }
      try {
        await this.rebase(await Access.load(this.db, claimed.principal), model, id, Number(claimed.revision));
      } catch (error) {
        const current = (await this.db.query(`SELECT revision FROM ${s}.scenarios WHERE owner=$1 AND id=$2`, [owner, id])).rows[0];
        // An edit since the claim moved the revision: the next sync tries again.
        if (Number(current?.revision) !== Number(claimed.revision)) return;
        if (error instanceof Conflict || error instanceof PermissionDenied || error instanceof NotFound) {
          await record('conflict', error.message.slice(0, 500));
          return;
        }
        throw error;
      }
    });
    return true;
  }
  /** Whether live commits after `after` through `through` touched the Scenario's staged objects or staged links' ends. */
  private async stagedTouched(owner: string, id: string, after: string, through: string) {
    const s = this.db.schema;
    const { rows: [row] } = await this.db.query<{ touched: boolean }>(`WITH commits AS (
        SELECT xact FROM ${s}.change_commits WHERE owner=$1 AND commit_seq>$2::bigint AND commit_seq<=$3::bigint)
      SELECT EXISTS (SELECT 1 FROM commits c JOIN ${s}.edit_history h ON h.xact=c.xact AND h.owner=$1
          JOIN ${s}.scenario_objects d ON d.scenario_id=$4 AND d.owner=$1 AND d.type=h.type AND d.id=h.id)
        OR EXISTS (SELECT 1 FROM commits c JOIN ${s}.link_history l ON l.xact=c.xact AND l.owner=$1
          JOIN ${s}.scenario_links d ON d.scenario_id=$4 AND d.owner=$1 AND d.type=l.type
            AND ((d.from_type,d.from_id)=(l.from_type,l.from_id) OR (d.to_type,d.to_id)=(l.to_type,l.to_id))) AS touched`,
      [owner, after, through, id]);
    return Boolean(row?.touched);
  }
  async rebase(access: Access, model: PublishedOntology, id: string, revision: number) {
    z.number().int().positive().parse(revision);
    const owner = access.principal.owner;
    return this.db.transaction(async client => {
      await access.refresh(client);
      access.require(model.document.id, 'view_definition', model.document.id);
      await lockEdits(this.db, model, owner, client);
      const view = await this.view(access, model, id, client);
      await checkScenario(this.db, view, owner, client, true);
      const row = (await this.db.query(`SELECT revision FROM ${this.db.schema}.scenarios WHERE owner=$1 AND id=$2`, [owner, id], client)).rows[0]!;
      if (Number(row.revision) !== revision) throw new Conflict('Scenario changed after review');
      const objects = await this.objectChangesWithLive(model, owner, id, client);
      const merged: { type: string; id: string; revision: string; base: Properties; properties: Properties; fields: string[] }[] = [];
      for (const item of objects) {
        const ref = { type: item.type, id: item.id };
        for (const snapshot of [item.base_properties, item.properties]) if (snapshot) access.readRow(model, item.type, snapshot);
        const current = item.live_revision && item.live_properties
          ? { revision: item.live_revision, properties: item.live_properties } : undefined;
        if (current) access.readRow(model, item.type, current.properties);
        if ((item.live_links?.length ?? 0) > 10000) throw new Conflict('Object relationships exceed the complete snapshot limit');
        if (item.properties === null && digest(item.live_links) !== digest(item.base_links)) {
          throw new Conflict('Scenario deletion conflicts with current relationships');
        }
        if ((current?.revision ?? null) === item.base_revision && digest(current?.properties ?? null) === digest(item.base_properties)) continue;
        if (!current || !item.base_properties || !item.properties) throw new Conflict('Scenario create or delete conflicts with current data');
        const fields = editedFields(item);
        const next = { ...current.properties };
        for (const field of fields) {
          if (!access.cell(model, ref.type, field, item.base_properties) || !access.cell(model, ref.type, field, current.properties)) {
            throw new PermissionDenied('Cannot rebase an unavailable property');
          }
          const liveValue = fieldValue(current.properties, field);
          if (liveValue !== fieldValue(item.base_properties, field) && liveValue !== fieldValue(item.properties, field)) {
            throw new Conflict('Scenario and current data changed the same property');
          }
          if (Object.hasOwn(item.properties, field)) next[field] = item.properties[field];
          else delete next[field];
        }
        access.readRow(model, ref.type, next);
        merged.push({ ...ref, revision: current.revision, base: current.properties, properties: model.parseObject(ref, next), fields });
      }
      if (await this.hasLinkConflicts(model, owner, id, client)) throw new Conflict('Scenario link conflicts with current data or cardinality');
      if (merged.length) {
        await this.db.query(`UPDATE ${this.db.schema}.scenario_objects d
          SET base_revision=v.revision,base_properties=v.base,properties=v.properties,edited_fields=v.fields,revision=d.revision+1
          FROM jsonb_to_recordset($3::jsonb) v(type text,id text,revision bigint,base jsonb,properties jsonb,fields jsonb)
          WHERE d.owner=$1 AND d.scenario_id=$2 AND d.type=v.type AND d.id=v.id`, [owner,id,JSON.stringify(merged)],client);
        await bumpScenario(this.db, view, owner, client);
      }
      // A rebase brings the Scenario up to the owner's latest commit, and resolves a conflict that stopped automatic sync.
      // A Scenario created before automatic sync has no creator to sync as; its first explicit rebase records the author.
      const author={owner:access.principal.owner,scopes:[...access.principal.scopes],...(access.principal.memberAccess?{memberAccess:true}:{})};
      await this.db.query(`UPDATE ${this.db.schema}.scenarios SET sync_state='current',sync_error=NULL,synced_at=now(),principal=coalesce(principal,$3::jsonb),
        sync_position=(SELECT coalesce(max(commit_seq),0) FROM ${this.db.schema}.change_commits WHERE owner=$1) WHERE owner=$1 AND id=$2`,
        [owner, id, JSON.stringify(author)], client);
      await access.refresh(client);
      return { id, revision: revision + Number(merged.length > 0) };
    });
  }
  private async hasLinkConflicts(model: PublishedOntology, owner: string, id: string, client: Sql) {
    const s = this.db.schema;
    const cardinalities = [...model.links.values()].map(link => ({
      type: link.apiName, one_from: link.from.cardinality === 'one', one_to: link.to.cardinality === 'one',
    }));
    const result = await this.db.query(`SELECT 1 FROM ${s}.scenario_links d
      LEFT JOIN jsonb_to_recordset($4::jsonb) c(type text,one_from boolean,one_to boolean) ON c.type=d.type
      WHERE d.owner=$1 AND d.scenario_id=$2 AND (NOT d.removed) IS DISTINCT FROM d.base_present
      AND (c.type IS NULL OR (EXISTS(SELECT 1 FROM ${s}.links l WHERE l.projection=$3 AND l.owner=$1 AND l.type=d.type
        AND l.from_type=d.from_type AND l.from_id=d.from_id AND l.to_type=d.to_type AND l.to_id=d.to_id)) IS DISTINCT FROM d.base_present
      OR (NOT d.removed AND EXISTS (
        SELECT 1 FROM ${s}.links l WHERE l.projection=$3 AND l.owner=$1 AND l.type=d.type
          AND ((c.one_from AND (l.from_type,l.from_id)=(d.from_type,d.from_id) AND (l.to_type,l.to_id)<>(d.to_type,d.to_id))
           OR (c.one_to AND (l.to_type,l.to_id)=(d.to_type,d.to_id) AND (l.from_type,l.from_id)<>(d.from_type,d.from_id)))
          AND NOT EXISTS (SELECT 1 FROM ${s}.scenario_links r WHERE r.scenario_id=$2 AND r.owner=$1 AND r.type=l.type
            AND r.from_type=l.from_type AND r.from_id=l.from_id AND r.to_type=l.to_type AND r.to_id=l.to_id
            AND r.removed AND r.base_present)))) LIMIT 1`, [owner,id,model.projection,JSON.stringify(cardinalities)],client);
    return Boolean(result.rowCount);
  }
  private async linkConflict(model: PublishedOntology, owner: string, item: Record<string, any>, client: Sql) {
    const present = (await this.db.query(`SELECT 1 FROM ${this.db.schema}.links WHERE projection=$1 AND owner=$2 AND type=$3 AND from_type=$4 AND from_id=$5 AND to_type=$6 AND to_id=$7`,
      [model.projection, owner, item.type, item.from_type, item.from_id, item.to_type, item.to_id], client)).rowCount! > 0;
    return present !== item.base_present || await this.cardinalityConflict(model, owner, item, client);
  }
  private async cardinalityConflict(model: PublishedOntology, owner: string, item: Record<string,any>, client: Sql): Promise<boolean> {
    if (item.removed) return false;
    const definition = model.links.get(item.type)!;
    const directions = (['from','to'] as const).filter(side=>definition[side].cardinality==='one');
    for (const side of directions) {
      const other = side==='from'?'to':'from';
      const rows = await this.db.query(`SELECT 1 FROM ${this.db.schema}.links l WHERE projection=$1 AND owner=$2 AND type=$3
        AND ${side}_type=$4 AND ${side}_id=$5 AND (${other}_type,${other}_id)<>($6,$7)
        AND NOT EXISTS(SELECT 1 FROM ${this.db.schema}.scenario_links d WHERE d.scenario_id=$8 AND d.owner=l.owner AND d.type=l.type
          AND d.from_type=l.from_type AND d.from_id=l.from_id AND d.to_type=l.to_type AND d.to_id=l.to_id AND d.removed AND d.base_present) LIMIT 1`,
        [model.projection,owner,item.type,item[side+'_type'],item[side+'_id'],item[other+'_type'],item[other+'_id'],item.scenario_id],client);
      if (rows.rowCount) return true;
    }
    return false;
  }
  async discard(access: Access, model: PublishedOntology, id: string, revision: number, beforeCommit?: (client: Sql) => Promise<void>) {
    const view = await this.view(access, model, id), owner = access.principal.owner;
    return this.db.transaction(async client => {
      await beforeCommit?.(client);
      await lockEdits(this.db, model, owner, client); await checkScenario(this.db, view, owner, client, true);
      const result = await this.db.query(`UPDATE ${this.db.schema}.scenarios SET state='discarded',revision=revision+1 WHERE id=$1 AND owner=$2 AND revision=$3 RETURNING id,state,revision`, [id, owner, z.number().int().positive().parse(revision)], client);
      if (!result.rowCount) throw new Conflict('Scenario revision changed');
      await syncScenarioMetadata(this.db,model,id,client);
      await access.refresh(client); await beforeCommit?.(client);
      const row=result.rows[0]!;return {id:String(row.id),state:String(row.state),revision:Number(row.revision)};
    });
  }
  /** Called only from a published merge Action, inside its atomic edit transaction. */
  async mergeInto(graph: Objects, id: string, revision: number, scope: {
    objects: string[]; links: string[];
    validate?: (view: Objects, touched: { ref: ObjectRef; deleted: boolean }[], links: LinkData[]) => Promise<void>;
    validateAction?: ValidateAction;
  }) {
    if (graph.client === this.db.pool || graph.model.scenario) throw new Conflict('Merge requires a live Action transaction');
    const { model, owner, access, client } = graph;
    await graph.lockWrites();
    const view = await this.view(access, model, id, client); await checkScenario(this.db, view, owner, client, true);
    const row = (await this.db.query<ReviewableScenario>(`SELECT id,owner,name,revision,reviewers,journal_steps,workflow_run_id FROM ${this.db.schema}.scenarios WHERE owner=$1 AND id=$2`, [owner, id], client)).rows[0]!;
    if (Number(row.revision) !== revision) throw new Conflict('Scenario changed after review');
    let proposalTask: string | undefined;
    let validateWorkflow: ((candidate: Objects) => Promise<void>) | undefined;
    let evidenceCheck: ReturnType<Scenarios['decisionCheckpoint']> | undefined;
    if (row.workflow_run_id) {
      const run = (await this.db.query<{ proposal_task: string; result_permissions: Requirement[] | null; proposal: unknown; object_ref: unknown; cognitive_context: unknown;
        cognitive_evidence: unknown; scopes: string[] }>(
        `SELECT run.proposal_task,task.result_permissions,task.cognitive_context,task.cognitive_evidence,task.scopes,run.body->'proposal' AS proposal,run.object_ref FROM ${this.db.schema}.workflow_runs run
          JOIN ${this.db.schema}.tasks task ON task.id=run.proposal_task AND task.owner=run.owner AND task.state='completed'
          WHERE run.id=$1 AND run.owner=$2 AND run.proposal_scenario=$3 AND run.state='waiting-approval'
            AND run.body->'proposal'->>'mergeAction'=$4 AND run.proposal_deadline>clock_timestamp() FOR UPDATE OF run`,
        [row.workflow_run_id, owner, id, graph.change?.action ?? null], client,
      )).rows[0];
      if (!run) throw new Conflict('Workflow proposal is no longer waiting for approval or requires a different merge Action');
      const { evidenceVersion } = cognitiveContextSchema.parse(run.cognitive_context);
      if (evidenceVersion) await requireDecisionVersion(this.db, model, owner, evidenceVersion, client);
      else {
        const observations = recordedDecisionEvidence(run.cognitive_evidence);
        const author = await Access.load(this.db, { owner, scopes: run.scopes }, client);
        await this.lockDecisionSets(model, owner, observations, client);
        evidenceCheck = this.decisionCheckpoint(model, id, run.proposal_task, observations, author);
      }
      if (!run.result_permissions || !await access.canReturn(run.result_permissions, client))
        throw new PermissionDenied('Workflow proposal no longer has access to its evidence');
      const proposal = cognitiveStepSchema.parse(run.proposal), object = objectRefSchema.parse(run.object_ref);
      const commit = workflowMerge(model, proposal, object, id, revision);
      if (graph.change?.inputDigest !== digest({ release: model.release, action: commit.action, input: commit.input }))
        throw new Conflict('Workflow merge input differs from the reviewed commitment');
      const validate = graph.change.validateWorkflow;
      if (!validate) throw new Conflict('Workflow merge requires its published proposal validation');
      validateWorkflow = candidate => validate(candidate, proposal.validation, object);
      graph.change.taskId = run.proposal_task;
      proposalTask = run.proposal_task;
    }
    let approvalSnapshot: string | undefined;
    if (row.reviewers.length) {
      const approvals = (await this.db.query<{ reviewer: string; snapshot: string }>(
        `SELECT reviewer,snapshot FROM ${this.db.schema}.scenario_approvals WHERE owner=$1 AND scenario_id=$2 AND revision=$3 AND reviewer=ANY($4::text[])`,
        [owner, id, revision, row.reviewers], client,
      )).rows;
      for (const approval of approvals) {
        try {
          const review = await this.reviewDiff(model, row, approval.reviewer, client, !evidenceCheck);
          if (!review.conflicts && approval.snapshot === review.snapshot) {
            if (this.decisions) {
              const reviewer = await Access.load(this.db, { owner: approval.reviewer, scopes: [] }, client);
              if (!await this.decisions.validateApproval({ model, owner, reviewer, client, review })) continue;
            }
            approvalSnapshot = approval.snapshot;
            if (proposalTask && graph.change) {
              graph.change.reviewedChangeDigest = changeDigest(review.objects,
                review.links.map(({ type, from, to, removed }) => ({ edge: { type, from, to }, removed })));
            }
            break;
          }
        } catch (error) {
          if (!(error instanceof PermissionDenied) && !(error instanceof NotFound)) throw error;
        }
      }
      if (!approvalSnapshot) throw new Conflict('Scenario requires approval from an invited reviewer for this revision');
    }
    const changes = {
      objects: await this.objectChangesWithLive(model, owner, id, client),
      links: await this.changedLinks(owner, id, client),
    };
    if (changes.objects.length > 10000 || changes.links.length > 10000)
      throw new Conflict('Scenario merge exceeds 10000 object or link changes');
    if (changes.objects.some(item => !scope.objects.includes(item.type)) || changes.links.some(item => !scope.links.includes(item.type))) throw new Conflict('Scenario contains edits outside this merge Action scope');
    const actions = await this.steps(owner, id, client);
    if (proposalTask && (actions.length === 0 || (await this.db.query(
      `SELECT 1 FROM ${this.db.schema}.scenario_actions
        WHERE owner=$1 AND scenario_id=$2 AND task_id IS DISTINCT FROM $3::uuid LIMIT 1`,
      [owner, id, proposalTask], client,
    )).rowCount)) throw new Conflict('Workflow proposal contains edits from outside its cognitive step');
    const currentRevisions = new Map<ScenarioObjectEdit, number>();
    const changedLive = new Set<string>();
    for (const item of changes.objects) {
      const live = item.live_revision && item.live_properties
        ? { revision: item.live_revision, properties: item.live_properties } : undefined;
      if (objectConflict(item, live, row.journal_steps > 0))
        throw new Conflict('Scenario object conflicts with current data; rebase or propose and review again');
      if (live) {
        currentRevisions.set(item, Number(live.revision));
        if (digest(live.properties) !== digest(item.base_properties)) changedLive.add(digest({type:item.type,id:item.id}));
      }
      if ((item.live_links?.length ?? 0) > 10000) throw new Conflict('Object relationships exceed the complete snapshot limit');
      if (item.properties === null && digest(item.live_links) !== digest(item.base_links))
        throw new Conflict('Scenario deletion conflicts with current relationships');
    }
    const deleted = (await this.db.query(`SELECT type,id,base_revision FROM ${this.db.schema}.scenario_objects WHERE owner=$1 AND scenario_id=$2 AND properties IS NULL`, [owner,id],client)).rows;
    const deletions = new Map(deleted.map(item => [digest({type:item.type,id:item.id}),item]));
    for (const action of actions) {
      const requirements: Requirement[] = action.requirements.map(requirement => {
        const dependency = requirement.row;
        const deletion = dependency?.scenario === id ? deletions.get(digest({type:dependency.type,id:dependency.id})) : undefined;
        if (!dependency || !deletion) return requirement;
        if (deletion.base_revision !== null) {
          // Authorize a staged deletion against the surviving live input, before its atomic removal.
          const { scenario: _scenario, ...row } = dependency;
          return { ...requirement, row };
        }
        // Created-then-deleted objects have no surviving input. Grants and the recorded policy context still apply.
        const { row: _row, ...permissions } = requirement;
        return permissions;
      });
      if (!await access.canReturn(requirements,client)) throw new PermissionDenied('Permission changed for scenario inputs');
      if (changedLive.size) {
        const liveRequirements = requirements.flatMap<Requirement>(requirement => {
          if (!requirement.row) return [requirement];
          const { scenario, ...dependency } = requirement.row;
          return scenario === id && changedLive.has(digest({type:dependency.type,id:dependency.id}))
            ? [{ ...requirement, row: dependency }] : [];
        });
        if (!await access.canReturn(liveRequirements, client)) throw new PermissionDenied('Permission changed for current Scenario inputs');
      }
      for (const requirement of action.requirements) access.require(requirement.ontology, requirement.permission, requirement.resource);
    }
    const touched = new Map<string, { ref: ObjectRef; deleted: boolean }>();
    for (const item of changes.objects) { const ref={type:String(item.type),id:String(item.id)}; touched.set(digest(ref),{ref,deleted:item.properties===null}); }
    for (const item of changes.links) { const ref={type:String(item.from_type),id:String(item.from_id)}; if(!touched.has(digest(ref)))touched.set(digest(ref),{ref,deleted:false}); }
    const edge = (item: Record<string, any>): LinkData => ({ type: item.type, from: { type: item.from_type, id: item.from_id }, to: { type: item.to_type, id: item.to_id } });
    if (await this.hasLinkConflicts(model, owner, id, client))
      throw new Conflict('Scenario link conflicts with current data or cardinality; rebase or propose and review again');
    await this.validateSteps(graph, view, row, actions, changes, async candidate => {
      evidenceCheck?.assertComplete();
      await validateWorkflow?.(candidate);
      await scope.validate?.(candidate, [...touched.values()], changes.links.map(edge));
    }, scope.validateAction, evidenceCheck?.check);
    await graph.unlinkScenarioLinks(changes.links.filter(item => item.removed).map(edge));
    const batch: ScenarioObjectWrite[] = [];
    for (const item of changes.objects) {
      const ref: ObjectRef = { type: item.type, id: item.id };
      if (item.properties === null || ref.type === documentChunkType) {
        if (batch.length) await graph.writeScenarioObjects(batch.splice(0));
        if (item.properties === null) {
          if (item.base_revision !== null) await graph.remove(ref, currentRevisions.get(item)!);
        } else if (item.base_revision === null) await graph.create(ref, item.properties);
        else await graph.edit(ref, currentRevisions.get(item)!,
          Object.fromEntries(editedFields(item).map(field => [field, item.properties?.[field]])));
        continue;
      }
      batch.push(item.base_revision === null ? { ref, fields: item.properties } : {
        ref, revision: currentRevisions.get(item)!,
        fields: Object.fromEntries(editedFields(item).map(field => [field, item.properties?.[field]])),
      });
    }
    await graph.writeScenarioObjects(batch);
    await graph.linkBatch(changes.links.filter(item => !item.removed).map(edge), true);
    await this.db.query(`UPDATE ${this.db.schema}.scenarios SET state='merged',revision=revision+1 WHERE owner=$1 AND id=$2`, [owner, id], client);
    if (row.workflow_run_id && !(await this.db.query(
      `UPDATE ${this.db.schema}.workflow_runs SET state='completed',step=step+1,updated_at=now() WHERE id=$1 AND proposal_deadline>clock_timestamp()`,
      [row.workflow_run_id], client,
    )).rowCount) throw new Conflict('Workflow proposal expired before commit');
    await syncScenarioMetadata(this.db,model,id,client);
    if (graph.change?.requestId) await appendTrace(this.db, {
      owner, release: model.release, projection: model.projection, scenarioId: id,
      requestId: graph.change.requestId, taskId: proposalTask ?? graph.change.taskId,
    }, { kind: 'merge', revision, approvalSnapshot }, client, await access.finalDataRequirements(client));
  }
}
