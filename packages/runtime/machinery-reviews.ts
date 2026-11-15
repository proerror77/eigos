import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Conflict, NotFound, requireScope } from '../core/identity.js';
import { ontologyName } from '../ontology/schema.js';
import { Access } from './access.js';
import type { Database, Sql } from './database.js';
import { analyzeMachinery, listMachineryProcesses, machineryAnalysisSchema } from './machinery-analysis.js';
import type { Metadata, PublishedOntology } from './metadata.js';

const day = 86400000;
export const machineryReviewSchema = z.strictObject({
  id: z.uuid().optional(),
  revision: z.number().int().min(0).default(0),
  name: z.string().min(1).max(200),
  type: ontologyName,
  periodDays: z.number().int().min(1).max(90).default(7),
  durationClock: z.enum(['recordedAt', 'observedAt']).default('recordedAt'),
  minCases: z.number().int().min(1).max(20000).default(2),
  enabled: z.boolean().default(false),
});
const reviewDefinition = machineryReviewSchema.omit({ id: true, revision: true, enabled: true });
const checkpointSchema = z.strictObject({
  release: z.string(), from: z.iso.datetime(), to: z.iso.datetime(),
});
type Checkpoint = z.output<typeof checkpointSchema>;
type RuleRow = {
  id: string; owner: string; ontology: string; revision: number; enabled: boolean;
  body: { machineryReview: unknown; checkpoint?: unknown }; scopes: unknown;
  last_scan: Date | null; error: string | null;
};

export class MachineryReviews {
  constructor(private readonly db: Database, private readonly metadata: Metadata) {}

  private definition(access: Access, model: PublishedOntology, row: RuleRow) {
    const definition = reviewDefinition.parse(row.body.machineryReview);
    if (!listMachineryProcesses(access, model).items.some(process => process.type === definition.type))
      throw new NotFound('Machinery review is unavailable');
    return definition;
  }

  async save(access: Access, model: PublishedOntology, input: z.output<typeof machineryReviewSchema>) {
    requireScope(access.principal, 'ontology:read');
    if ((input.id === undefined) !== (input.revision === 0)) throw new Conflict('Supply the current revision when updating a review');
    const { id, revision, enabled, ...definition } = input;
    if (!listMachineryProcesses(access, model).items.some(process => process.type === input.type))
      throw new NotFound('Machinery process is unavailable');
    const owner = access.principal.owner;
    type Saved = { id: string; revision: number };
    return this.db.transaction(async client => {
      await access.refresh(client);
      if ((await this.metadata.active(model.document.id, client)).release !== model.release)
        throw new Conflict('The process publication changed');
      const body = { machineryReview: definition };
      const scopes = JSON.stringify(access.principal.scopes);
      const result = id
        ? await this.db.query<Saved>(`UPDATE ${this.db.schema}.object_rules
            SET name=$4,body=$5,enabled=$6,scopes=$7,revision=revision+1,error=NULL,last_scan=NULL
            WHERE id=$1 AND owner=$2 AND ontology=$3 AND revision=$8 AND body ? 'machineryReview'
            RETURNING id,revision`, [id, owner, model.document.id, input.name, body, enabled, scopes, revision], client)
        : await this.db.query<Saved>(`INSERT INTO ${this.db.schema}.object_rules(id,owner,ontology,name,body,revision,enabled,scopes)
            VALUES($1,$2,$3,$4,$5,1,$6,$7) RETURNING id,revision`,
          [randomUUID(), owner, model.document.id, input.name, body, enabled, scopes], client);
      if (!result.rowCount) throw new Conflict('Machinery review changed or is unavailable');
      return { ...definition, ...result.rows[0]!, enabled };
    });
  }

  async list(access: Access, model: PublishedOntology) {
    const types = listMachineryProcesses(access, model).items.map(process => process.type);
    const { rows } = await this.db.query<RuleRow>(`SELECT * FROM ${this.db.schema}.object_rules
      WHERE owner=$1 AND ontology=$2 AND body->'machineryReview'->>'type'=ANY($3::text[])
      ORDER BY name,id LIMIT 101`, [access.principal.owner, model.document.id, types]);
    return { items: rows.slice(0, 100).map(row => ({
      ...reviewDefinition.parse(row.body.machineryReview), id: row.id, revision: row.revision, enabled: row.enabled,
      lastScan: row.last_scan, checkpoint: row.body.checkpoint ? checkpointSchema.parse(row.body.checkpoint) : null,
      error: row.error,
    })), hasMore: rows.length > 100 };
  }

  private async report(access: Access, model: PublishedOntology, row: RuleRow, checkpoint: Checkpoint) {
    const definition = this.definition(access, model, row);
    if (checkpoint.release !== model.release) throw new Conflict('The publication changed. Run the review again.');
    return this.db.withOwner(access.principal.owner, () => analyzeMachinery(this.db, access, model,
      machineryAnalysisSchema.parse({
        type: definition.type, from: checkpoint.from, to: checkpoint.to,
        mining: { minCases: definition.minCases }, includeIdle: false, durationClock: definition.durationClock,
      })));
  }

  private async compute(access: Access, model: PublishedOntology, row: RuleRow, client: Sql) {
    const definition = this.definition(access, model, row);
    const to = (await this.db.query<{ at: Date }>('SELECT clock_timestamp() AS at', [], client)).rows[0]!.at;
    const checkpoint: Checkpoint = { release: model.release, to: to.toISOString(),
      from: new Date(to.getTime() - definition.periodDays * day).toISOString() };
    const report = await this.report(access, model, row, checkpoint);
    await this.db.withOwner(access.principal.owner, async () => {
      if (!await access.canReturn(access.dataRequirements()))
        throw new Conflict('Machinery review permissions changed');
    });
    // Persist the authorized analysis window, not a cache of protected object data.
    await this.db.query(`UPDATE ${this.db.schema}.object_rules SET last_scan=$2,error=NULL,body=$3 WHERE id=$1`,
      [row.id, to, { machineryReview: definition, checkpoint }], client);
    return report;
  }

  async read(access: Access, model: PublishedOntology, id: string, run: boolean) {
    return this.db.transaction(async client => {
      const result = await this.db.query<RuleRow>(`SELECT * FROM ${this.db.schema}.object_rules
        WHERE id=$1 AND owner=$2 AND ontology=$3 AND body ? 'machineryReview'${run ? ' FOR UPDATE' : ''}`,
        [id, access.principal.owner, model.document.id], client);
      const row = result.rows[0];
      if (!row) throw new NotFound('Machinery review is unavailable');
      if (run) return this.compute(access, model, row, client);
      if (!row.body.checkpoint) throw new Conflict('This Machinery review has no completed analysis');
      return this.report(access, model, row, checkpointSchema.parse(row.body.checkpoint));
    });
  }

  async scanOne(): Promise<boolean> {
    return this.db.transaction(async client => {
      const result = await this.db.query<RuleRow>(`SELECT * FROM ${this.db.schema}.object_rules
        WHERE enabled AND body ? 'machineryReview'
          AND (last_scan IS NULL OR last_scan <= clock_timestamp() -
            (body->'machineryReview'->>'periodDays')::integer * interval '24 hours')
        ORDER BY last_scan NULLS FIRST,id FOR UPDATE SKIP LOCKED LIMIT 1`, [], client);
      const row = result.rows[0];
      if (!row) return false;
      try {
        const principal = { owner: row.owner, scopes: z.array(z.string()).parse(row.scopes) };
        requireScope(principal, 'ontology:read');
        const model = await this.metadata.active(row.ontology);
        const access = await Access.load(this.db, principal);
        await this.compute(access, model, row, client);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === '55P03' || code === '40001' || code === '40P01') return true;
        if (!(error instanceof NotFound || error instanceof Conflict || error instanceof z.ZodError) && !code)
          process.stderr.write('Machinery review scan failed\n');
        await this.db.query(`UPDATE ${this.db.schema}.object_rules SET last_scan=clock_timestamp(),
          error='Review failed; verify process permissions, publication and analysis window' WHERE id=$1`, [row.id], client);
      }
      return true;
    });
  }
}
