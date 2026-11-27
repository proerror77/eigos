import { ScheduledActions } from './scheduled-actions.js';
import { Conflict, digest, NotFound, PermissionDenied, type Principal } from '../core/identity.js';
import { compileMachineryExecution } from '../ontology/process-definition.js';
import type { ObjectRef } from '../ontology/schema.js';
import { Access } from './access.js';
import type { ChangeFootprint } from './change-feed.js';
import type { Database, Sql } from './database.js';
import type { MachineryExecution } from './machinery-execution.js';
import type { Metadata, PublishedOntology } from './metadata.js';

type Watch = { object: ObjectRef; release: string; forward: string[]; reverse: string[] };
export type SubscriptionFootprint = ChangeFootprint & { machinery?: Watch };

export function processFootprint(model: PublishedOntology, object: ObjectRef): SubscriptionFootprint {
  const edges = compileMachineryExecution(model).byType.get(object.type);
  if (!edges?.length) throw new Conflict('This type has no executable Machinery transitions');
  const types = new Set([object.type]), forward = new Set<string>(), reverse = new Set<string>();
  for (const edge of edges) for (const condition of edge.execution.requires ?? []) {
    if (!condition.link) continue;
    const nav = model.navigation(object.type, condition.link);
    types.add(nav.target);
    (nav.forward ? forward : reverse).add(nav.link);
  }
  return { types: [...types].sort(), links: [...new Set([...forward, ...reverse])].sort(), local: false,
    machinery: { object, release: model.release, forward: [...forward].sort(), reverse: [...reverse].sort() } };
}

/** Use the commit journal to test membership before reading any process instance. Unlinks retain both original endpoints. */
async function affected(db: Database, client: Sql, owner: string, model: PublishedOntology, watch: Watch, after: string, through: string) {
  const s = db.schema;
  const touches = (side: 'from' | 'to', links: string) =>
    `l.${side}_type=$5 AND l.${side}_id=$6 AND l.type=ANY(${links}::text[])`;
  const childEdit = (side: 'from' | 'to', other: 'from' | 'to', links: string) =>
    `EXISTS (SELECT 1 FROM ${s}.links l WHERE l.projection=$4 AND l.owner=$1 AND ${touches(side,links)}
       AND l.${other}_type=h.type AND l.${other}_id=h.id)`;
  const { rows: [row] } = await db.query(`WITH commit_window AS MATERIALIZED (
      SELECT commit_seq,xact FROM ${s}.change_commits WHERE owner=$1 AND commit_seq>$2 AND commit_seq<=$3 ORDER BY commit_seq LIMIT 500)
    SELECT max(commit_seq)::text AS position,
      EXISTS(SELECT 1 FROM commit_window w JOIN ${s}.edit_history h ON h.owner=$1 AND h.xact=w.xact AND h.projection=$4
        WHERE (h.type=$5 AND h.id=$6) OR ${childEdit('from','to','$7')} OR ${childEdit('to','from','$8')})
      OR EXISTS(SELECT 1 FROM commit_window w JOIN ${s}.link_history l ON l.owner=$1 AND l.xact=w.xact AND l.projection=$4
        WHERE (${touches('from','$7')}) OR (${touches('to','$8')})) AS touched FROM commit_window`,
    [owner,after,through,model.projection,watch.object.type,watch.object.id,watch.forward,watch.reverse],client);
  return { position: String(row!.position), touched: Boolean(row!.touched) };
}

export class MachineryWatchPlanner {
  constructor(private readonly db: Database, private readonly metadata: Metadata, private readonly execution: MachineryExecution) {}

  async replanSchedules(ontology: string, owner: string, watch: Watch, client: Sql) {
    const model = await this.metadata.active(ontology, client, true);
    if (model.release !== watch.release) throw new Conflict('The watched process publication changed');
    await new ScheduledActions(this.db,this.metadata).replanSubject(model,owner,watch.object,client);
  }

  async signature(model: PublishedOntology, access: Access, object: ObjectRef, client: Sql) {
    const plan = await this.execution.evaluate(model, access, { object }, client);
    if (!await access.canReturn(access.dataRequirements(),client)) throw new PermissionDenied('Machinery permissions changed');
    return digest(plan);
  }

  async inspect(ontology: string, principal: Principal, watch: Watch, after: string, through: string, client: Sql) {
    const model = await this.metadata.active(ontology,client);
    if (model.release !== watch.release) return { stopped: true } as const;
    if (after === through) return;
    const change = await affected(this.db,client,principal.owner,model,watch,after,through);
    if (!change.touched) return { end: change.position } as const;
    try {
      const access = await Access.load(this.db,principal,client);
      const signature = await this.signature(model,access,watch.object,client);
      return { end: change.position, signature } as const;
    } catch (error) {
      if (error instanceof PermissionDenied || error instanceof NotFound) return { stopped: true } as const;
      throw error;
    }
  }
}
