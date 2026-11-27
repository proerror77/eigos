import { z } from 'zod';
import type { Database, Sql } from './database.js';

/**
 * Provider budgets (runtime budget 06.3): each owner may call each provider at a bounded rate. A token bucket per owner
 * and provider, kept in PostgreSQL so every process shares it, refills at `perMinute` tokens a minute up to `burst`.
 * A call without a token is deferred, not failed: a task resumes when the bucket has refilled, and a direct request
 * learns when to retry.
 */
export const providerRatesSchema = z.record(z.string().min(1).max(80),
  z.strictObject({ perMinute: z.number().positive().max(100000), burst: z.number().int().min(1).max(100000) }));
export type ProviderRates = z.output<typeof providerRatesSchema>;

/** The rates of EIGOS_PROVIDER_RATES, a JSON object by source name; providers not named are not limited. */
export function configuredProviderRates(text = process.env.EIGOS_PROVIDER_RATES): ProviderRates {
  return text ? providerRatesSchema.parse(JSON.parse(text)) : {};
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
}

export class ProviderBudgets {
  constructor(private readonly db: Database, private readonly rates: ProviderRates = configuredProviderRates()) {}

  /** Takes one token of the owner's budget for `provider`, or throws ProviderBudgetExceeded with when one will be back. */
  async take(owner: string, provider: string, client?: Sql) {
    if (!Object.hasOwn(this.rates, provider)) return;
    const rate = this.rates[provider]!;
    const perSecond = rate.perMinute / 60;
    // Refill since the last take, capped at the burst, then take one token if there is one.
    const refilled = `least($3::double precision, b.tokens + extract(epoch FROM clock_timestamp()-b.refilled_at)::double precision*$4::double precision)`;
    const taken = await this.db.query<{ tokens: number }>(`INSERT INTO ${this.db.schema}.provider_budgets AS b(owner,provider,tokens,refilled_at)
      VALUES($1,$2,$3::double precision-1,clock_timestamp())
      ON CONFLICT (owner,provider) DO UPDATE SET tokens=${refilled}-1, refilled_at=clock_timestamp() WHERE ${refilled}>=1
      RETURNING tokens`, [owner, provider, rate.burst, perSecond], client);
    if (taken.rowCount) return;
    const { rows: [left] } = await this.db.query<{ tokens: number }>(`SELECT ${refilled} AS tokens FROM ${this.db.schema}.provider_budgets b
      WHERE owner=$1 AND provider=$2`, [owner, provider, rate.burst, perSecond], client);
    const seconds = Math.max(0, (1 - Number(left?.tokens ?? 0)) / perSecond);
    throw new ProviderBudgetExceeded(provider, new Date(Date.now() + Math.ceil(seconds * 1000)).toISOString());
  }
}
