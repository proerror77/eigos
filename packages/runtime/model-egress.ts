import { z } from 'zod';
import { digest } from '../core/identity.js';
import { allowsClassification, classificationSchema, internalClassification, type Classification } from '../ontology/classification.js';
import type { Database, Sql } from './database.js';

const name = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:/-]+$/);
export const modelClearanceSchema = z.strictObject({
  owner: z.string().min(1).max(200),
  provider: name,
  model: name,
  clearance: classificationSchema,
  active: z.boolean().default(true),
});
export type ModelClearance = z.output<typeof modelClearanceSchema>;
export const harnessProvider = 'openai-codex';

export async function initializeModelEgress(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.model_clearances (
    owner text NOT NULL, provider text NOT NULL, model text NOT NULL,
    active boolean NOT NULL, clearance jsonb NOT NULL, PRIMARY KEY(owner,provider,model));`);
}

export async function setModelClearance(db: Database, raw: unknown, client: Sql = db.pool) {
  const input = modelClearanceSchema.parse(raw);
  await db.query(`INSERT INTO ${db.schema}.model_clearances(owner,provider,model,active,clearance)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner,provider,model)
    DO UPDATE SET active=excluded.active,clearance=excluded.clearance`,
  [input.owner, input.provider, input.model, input.active, input.clearance], client);
}

export class ModelEgressDenied extends Error {
  constructor() { super('Data is unavailable to the selected model'); }
}

export class ModelEgress {
  constructor(private readonly db: Database, private readonly owner: string,
    private readonly model: string, private readonly provider?: string) {}
  async decide(required: Classification) {
    const provider = this.provider;
    const row = provider ? (await this.db.query(`SELECT active,clearance FROM ${this.db.schema}.model_clearances
      WHERE owner=$1 AND provider=$2 AND model=$3`, [this.owner, provider, this.model])).rows[0] : undefined;
    // The built-in transport has a pinned provider. Other external destinations require an exact grant.
    const clearance = row ? (row.active === true ? classificationSchema.parse(row.clearance) : undefined)
      : !provider || provider === harnessProvider ? internalClassification : undefined;
    const allowed = Boolean(clearance && allowsClassification(clearance, required));
    return { allowed, clearance, policyDigest: digest({ provider: provider ?? 'local-runtime', model: this.model, clearance: clearance ?? null }) };
  }
}
