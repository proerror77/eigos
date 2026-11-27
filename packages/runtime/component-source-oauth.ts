import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SourceReadFailure } from '../core/identity.js';
import type { ComponentSourceSecrets, SourceOAuthGrant } from './component-source-secrets.js';
import type { Database } from './database.js';

export class SourceOAuthReauthorization extends SourceReadFailure {
  constructor() { super('Source OAuth authorization must be renewed'); }
}

/** A verified pre-dispatch failure or an explicit rejection that issued no token. */
export class SourceOAuthRejection extends SourceReadFailure {
  constructor(cause?: unknown) { super('Source OAuth token exchange was rejected', { cause }); }
}

export async function initializeComponentOAuthGrants(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.component_source_oauth_grants (
    credential_key text PRIMARY KEY CHECK(credential_key ~ '^[0-9a-f]{64}$'),
    sealed_grant bytea,
    attempt uuid,
    attempt_until timestamptz,
    CHECK ((attempt IS NULL) = (attempt_until IS NULL))
  )`);
}

type RefreshClaim = { wait: true } | { grant: SourceOAuthGrant } | { attempt: string; refreshToken: string };

/**
 * An authorization server may revoke an old token as soon as it issues its replacement.
 * Reserve a refresh durably before dispatch; an ambiguous result must never replay that old token.
 */
export class ComponentOAuthGrants {
  constructor(private readonly db: Database, private readonly secrets: Pick<ComponentSourceSecrets, 'openGrant' | 'sealGrant'>) {}

  async token(identity: string, seed: () => Promise<string>,
    exchange: (refreshToken: string) => Promise<SourceOAuthGrant>, signal: AbortSignal) {
    for (let interval = 25; ; interval = Math.min(interval * 2, 250)) {
      signal.throwIfAborted();
      const found = await this.claim(identity, seed, signal);
      if ('grant' in found) return found.grant.accessToken;
      if ('wait' in found) { await delay(interval, undefined, { signal }); continue; }

      try {
        // After dispatch, finish persisting the server result even if the caller cancels.
        const refreshed = await exchange(found.refreshToken);
        const encrypted = await this.secrets.sealGrant(identity, refreshed);
        const saved = await this.db.query(`UPDATE ${this.db.schema}.component_source_oauth_grants
          SET sealed_grant=$3,attempt=NULL,attempt_until=NULL WHERE credential_key=$1 AND attempt=$2`, [identity, found.attempt, encrypted]);
        if (!saved.rowCount) throw new SourceOAuthReauthorization();
        return refreshed.accessToken;
      } catch (error) {
        // A known rejection preserves the previous grant. Expire ambiguous attempts without allowing reuse.
        if (error instanceof SourceOAuthRejection) {
          await this.db.query(`UPDATE ${this.db.schema}.component_source_oauth_grants SET attempt=NULL,attempt_until=NULL
            WHERE credential_key=$1 AND attempt=$2`, [identity, found.attempt]);
          throw error.cause ?? error;
        }
        await this.db.query(`UPDATE ${this.db.schema}.component_source_oauth_grants SET attempt_until=clock_timestamp()
          WHERE credential_key=$1 AND attempt=$2`, [identity, found.attempt]);
        throw new SourceOAuthReauthorization();
      }
    }
  }

  private claim(identity: string, seed: () => Promise<string>, signal: AbortSignal): Promise<RefreshClaim> {
    return this.db.transaction(async client => {
      const { db } = this;
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [db.lockKey('component-source-oauth', identity)], client);
      const { rows: [row] } = await db.query<{ sealed_grant: Buffer | null; active: boolean | null }>(`
        SELECT sealed_grant,attempt_until>clock_timestamp() AS active FROM ${db.schema}.component_source_oauth_grants
        WHERE credential_key=$1`, [identity], client);
      if (row?.active === true) return { wait: true };
      if (row?.active === false) throw new SourceOAuthReauthorization();
      const grant = row?.sealed_grant && await this.secrets.openGrant(identity, row.sealed_grant);
      if (grant && grant.validUntil > Date.now()) return { grant };
      const refreshToken = grant?.refreshToken ?? await seed();
      if (!refreshToken || refreshToken.length > 64 * 1024) throw new SourceReadFailure('Invalid Source OAuth refresh credential');
      signal.throwIfAborted();
      const attempt = randomUUID();
      await db.query(`INSERT INTO ${db.schema}.component_source_oauth_grants(credential_key,attempt,attempt_until)
        VALUES($1,$2,clock_timestamp()+interval '30 seconds') ON CONFLICT(credential_key) DO UPDATE
        SET attempt=excluded.attempt,attempt_until=excluded.attempt_until`, [identity, attempt], client);
      return { attempt, refreshToken };
    });
  }
}
