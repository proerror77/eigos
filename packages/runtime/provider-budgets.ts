import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import type { Database, Sql } from './database.js';

/**
 * Provider budgets (runtime budget 06.3): each owner may call each provider at a bounded rate. A token bucket per owner
 * and provider, kept in PostgreSQL so every process shares it, refills at `perMinute` tokens a minute up to `burst`.
 * A call without a token is deferred, not failed: a task resumes when the bucket has refilled, and a direct request
 * learns when to retry.
 */
const rateLimit = z.strictObject({ perMinute: z.number().positive().max(100000), burst: z.number().int().min(1).max(100000) });
export const providerRatesSchema = z.record(z.string().min(1).max(80), rateLimit);
const actionWriteRatesSchema = z.record(z.string().regex(/^[^/]+\/[^/]+$/).max(161), rateLimit);
export type ProviderRates = z.output<typeof providerRatesSchema>;

const providerQuotasSchema = z.record(z.string().min(1).max(80),
  z.strictObject({ period: z.enum(['day', 'month']), calls: z.number().int().min(1).max(2147483647) }));
type ProviderQuotas = z.output<typeof providerQuotasSchema>;

/** The rates of EIGOS_PROVIDER_RATES, a JSON object by source name; providers not named are not limited. */
export function configuredProviderRates(text = process.env.EIGOS_PROVIDER_RATES): ProviderRates {
  return text ? providerRatesSchema.parse(JSON.parse(text)) : {};
}

function configuredProviderQuotas(text = process.env.EIGOS_PROVIDER_QUOTAS): ProviderQuotas {
  return text ? providerQuotasSchema.parse(JSON.parse(text)) : {};
}

/** A provider call over its owner's budget. A Worker defers the task until `until`; a request answers 429. */
export class ProviderBudgetExceeded extends Error {
  constructor(readonly provider: string, readonly until: string) {
    super(`The ${provider} budget is used up until ${until}`);
  }
}

export async function initializeProviderBudgets(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.provider_budgets (
    owner text NOT NULL, provider text NOT NULL, tokens double precision NOT NULL, refilled_at timestamptz NOT NULL,
    PRIMARY KEY (owner, provider))`);
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.provider_quotas (
    owner text NOT NULL, provider text NOT NULL, period text NOT NULL CHECK (period IN ('day','month')),
    period_start timestamptz NOT NULL, calls integer NOT NULL CHECK (calls > 0),
    PRIMARY KEY (owner, provider, period))`);
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.action_write_budgets (
    owner text NOT NULL, action_key text NOT NULL, tokens double precision NOT NULL, refilled_at timestamptz NOT NULL,
    PRIMARY KEY (owner, action_key))`);
}

export class ProviderBudgets {
  constructor(private readonly db: Database, private readonly rates: ProviderRates = configuredProviderRates(),
    private readonly quotas: ProviderQuotas = configuredProviderQuotas()) {}

  /** Admits one attempt across the configured budgets, or throws with the time to try again. */
  async take(owner: string, provider: string) {
    const rate = Object.hasOwn(this.rates, provider) ? this.rates[provider] : undefined;
    const quota = Object.hasOwn(this.quotas, provider) ? this.quotas[provider] : undefined;
    if (!quota) {
      if (rate) await takeRate(this.db, 'provider_budgets', owner, provider, rate);
      return;
    }
    if (!rate) return this.takeQuota(owner, provider, quota);
    await this.db.transaction(async client => {
      await this.takeQuota(owner, provider, quota, client);
      await takeRate(this.db, 'provider_budgets', owner, provider, rate, client);
    });
  }

  /** Storing the current UTC window per period bounds the table to two rows per owner and provider. */
  private async takeQuota(owner: string, provider: string, quota: ProviderQuotas[string], client?: Sql) {
    const window = "date_trunc($3, statement_timestamp(), 'UTC')";
    const key = [owner, provider, quota.period];
    const taken = await this.db.query(`INSERT INTO ${this.db.schema}.provider_quotas AS q(owner,provider,period,period_start,calls)
      VALUES($1,$2,$3,${window},1)
      ON CONFLICT(owner,provider,period) DO UPDATE SET calls=CASE
        WHEN q.period_start=excluded.period_start THEN q.calls+1 ELSE 1 END,
        period_start=excluded.period_start
      WHERE q.period_start<excluded.period_start OR q.period_start=excluded.period_start AND q.calls<$4
      RETURNING calls`, [...key, quota.calls], client);
    if (taken.rowCount) return;
    const { rows: [current] } = await this.db.query<{ until: Date }>(`SELECT
      ((period_start AT TIME ZONE 'UTC') + CASE period WHEN 'day' THEN interval '1 day' ELSE interval '1 month' END)
        AT TIME ZONE 'UTC' AS until
      FROM ${this.db.schema}.provider_quotas WHERE owner=$1 AND provider=$2 AND period=$3`, key, client);
    if (!current) throw new Error('Provider quota window is unavailable');
    throw new ProviderBudgetExceeded(provider, current.until.toISOString());
  }
}

const actionWriting = new AsyncLocalStorage<string>();

export function withActionWriteBudget<T>(ontology: string, action: string, run: () => Promise<T>) {
  return actionWriting.run(`${ontology}/${action}`, run);
}

/** Source reads and external Action writes use independent buckets. */
export class ActionWriteBudgets {
  private readonly rates: z.output<typeof actionWriteRatesSchema>;
  constructor(private readonly db: Database, text = process.env.EIGOS_ACTION_WRITE_RATES) {
    this.rates = text ? actionWriteRatesSchema.parse(JSON.parse(text)) : {};
  }

  async take(owner: string, client?: Sql, action = actionWriting.getStore()) {
    if (action && Object.hasOwn(this.rates, action))
      await takeRate(this.db, 'action_write_budgets', owner, action, this.rates[action]!, client);
  }
}

async function takeRate(db: Database, table: 'provider_budgets' | 'action_write_budgets',
  owner: string, key: string, rate: z.output<typeof rateLimit>, client?: Sql) {
  const column = table === 'provider_budgets' ? 'provider' : 'action_key';
  const perSecond = rate.perMinute / 60;
  // Refill since the last take, capped at the burst, then take one token if there is one.
  const refilled = `least($3::double precision, b.tokens + extract(epoch FROM clock_timestamp()-b.refilled_at)::double precision*$4::double precision)`;
  const args = [owner, key, rate.burst, perSecond];
  const taken = await db.query(`INSERT INTO ${db.schema}.${table} AS b(owner,${column},tokens,refilled_at)
    VALUES($1,$2,$3::double precision-1,clock_timestamp())
    ON CONFLICT (owner,${column}) DO UPDATE SET tokens=${refilled}-1, refilled_at=clock_timestamp() WHERE ${refilled}>=1
    RETURNING tokens`, args, client);
  if (taken.rowCount) return;
  const { rows: [left] } = await db.query<{ tokens: number }>(`SELECT ${refilled} AS tokens FROM ${db.schema}.${table} b
    WHERE owner=$1 AND ${column}=$2`, args, client);
  const seconds = Math.max(0, (1 - Number(left?.tokens ?? 0)) / perSecond);
  throw new ProviderBudgetExceeded(key, new Date(Date.now() + Math.ceil(seconds * 1000)).toISOString());
}
