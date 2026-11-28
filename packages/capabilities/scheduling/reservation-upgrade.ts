import { Metadata } from '../../runtime/metadata.js';
import { ResourceReservations } from '../../runtime/resource-reservations.js';
import type { Database } from '../../runtime/database.js';

/** Run by the EIGOS installation upgrade. Only formal, committed plans in its active projection are considered. */
export async function backfillScheduleReservations(db: Database, ontology: string) {
  const s = db.schema;
  return db.transaction(async client => {
    // Exclude concurrent publication and all live edits, including first confirmation of previously unconfirmed plans.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[db.lockKey('publication',ontology)],client);
    if (!(await db.query(`SELECT 1 FROM ${s}.ontology WHERE id=$1`,[ontology],client)).rowCount) return 0;
    const model = await new Metadata(db,ontology).active(ontology,client);
    if (!model.objects.has('SchedulePlan') || !model.actions.has('CommitSchedulePlan') ||
        !model.links.has('PlanResource') || !model.links.has('ActivityPlan')) return 0;
    const plans = await db.query<{ owner:string; id:string }>(`SELECT o.owner,o.id FROM ${s}.objects o
      WHERE o.projection=$1 AND o.type='SchedulePlan' AND (o.properties->>'state'='confirmed' OR
        (o.properties->>'state' IS NULL AND EXISTS(SELECT 1 FROM ${s}.actions a JOIN ${s}.releases r ON r.digest=a.release
         WHERE a.owner=o.owner AND r.body->>'id'=$2 AND a.action='CommitSchedulePlan'
           AND a.result=jsonb_build_object('type',o.type,'id',o.id)))) ORDER BY o.owner,o.id`,[model.projection,ontology],client);
    let restored=0;
    const ledger = new ResourceReservations(db);
    for (const plan of plans.rows) {
      const holder=JSON.stringify([ontology,'SchedulePlan',plan.id]);
      const prior = await db.query(`SELECT 1 FROM ${s}.resource_reservations WHERE owner=$1 AND holder=$2 LIMIT 1`,[plan.owner,holder],client);
      if (prior.rowCount) continue; // Includes intentional releases and in-flight replacements.
      const rows = await db.query<{type:string;id:string;activity:string;start:string;end:string}>(`SELECT
          resource.to_type AS type,resource.to_id AS id,activity.id AS activity,activity.properties->>'start' AS start,activity.properties->>'end' AS end
        FROM ${s}.links item JOIN ${s}.objects activity ON activity.projection=item.projection AND activity.owner=item.owner
          AND activity.type=item.from_type AND activity.id=item.from_id
        JOIN ${s}.links resource ON resource.projection=item.projection AND resource.owner=item.owner
          AND resource.type='PlanResource' AND resource.from_type='SchedulePlan' AND resource.from_id=item.to_id
        WHERE item.projection=$1 AND item.owner=$2 AND item.type='ActivityPlan' AND item.to_type='SchedulePlan' AND item.to_id=$3
        ORDER BY activity.id,resource.to_id`,[model.projection,plan.owner,plan.id],client);
      if (!rows.rowCount) continue;
      await ledger.replace(plan.owner,holder,rows.rows.map(row=>({resource:JSON.stringify([plan.owner,ontology,row.type,row.id]),
        allocation:row.activity,start:row.start,end:row.end})),'committed',client);
      restored++;
    }
    return restored;
  });
}
