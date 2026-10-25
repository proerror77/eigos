import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Only the actually running backend is relevant. Retired prototype queue rows
// stay untouched and can never be claimed by the new Worker.
export function assertUpgradeIdle(path, activeBackend) {
  if (!activeBackend || !existsSync(path)) return;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const active = Number(db.prepare("SELECT count(*) AS n FROM jobs WHERE json_extract(body,'$.delegation.backendVersion')=? AND state IN ('working','submitted','input-required','auth-required')").get(activeBackend).n);
    const uncertain = Number(db.prepare("SELECT count(*) AS n FROM action_intents i JOIN jobs j ON j.id=i.job_id WHERE json_extract(j.body,'$.delegation.backendVersion')=? AND json_extract(i.body,'$.effect') NOT IN ('read','local') AND i.state IN ('dispatching','effect_unknown','awaiting_remote','needs_review')").get(activeBackend).n);
    if (active || uncertain) throw new Error(`Finish or reconcile the current backend before upgrade: ${active} active tasks, ${uncertain} uncertain business operations`);
  } finally { db.close(); }
}
