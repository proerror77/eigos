import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import type {ExecutionAttempt} from '../../packages/ontology/actions.js';
import type {WorkClaim} from '../../packages/core/store.js';

/** A pre-existing dispatched operation, not a new authorization path. */
export function historicalAttempt(database:string,claim:WorkClaim,intentId:string,planDigest:string):ExecutionAttempt {
  const attempt:ExecutionAttempt={id:randomUUID(),intentId,kind:'dispatch',requestKey:randomUUID(),startedAt:new Date().toISOString(),claimToken:claim.token,
    requestRevision:claim.job.revision??1,inputDigest:'historical-fixture',planDigest,ordinal:1};
  const db=new DatabaseSync(database);
  try{db.prepare('INSERT INTO action_attempts VALUES(?,?,?,?)').run(attempt.id,claim.owner,intentId,JSON.stringify(attempt));}
  finally{db.close();}
  return attempt;
}
