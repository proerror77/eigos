import { processLogTarget } from '../ontology/process-definition.js';
import type { Database } from './database.js';
import type { PublishedOntology } from './metadata.js';

type Tables = { prefix: string; objects: string; links: string };

/** Extend the existing read view only when a query navigates process log types. */
export function processLogTables(db: Database, model: PublishedOntology, owner: string, values: unknown[], base: Tables, types: readonly string[]) {
  const logs = [...new Set(types)].flatMap(type => {
    const target = processLogTarget(model, type);
    return target ? [target] : [];
  });
  if (!logs.length) return base;
  const bind = (value: unknown) => { values.push(value); return '$' + values.length; };
  const config = bind(JSON.stringify(logs)), projection = bind(model.projection), actor = bind(owner), release = bind(model.release);
  const prefix = base.prefix ? base.prefix.replace(/^WITH /, 'WITH RECURSIVE ').trimEnd() + ', ' : 'WITH RECURSIVE ';
  return { objects: 'process_view_objects', links: 'process_view_links', prefix: `${prefix}
    process_releases AS (
      SELECT digest,prepared_from FROM ${db.schema}.releases WHERE digest=${release}
      UNION ALL SELECT r.digest,r.prepared_from FROM ${db.schema}.releases r JOIN process_releases p ON r.digest=p.prepared_from
    ), process_log_rows AS (
      SELECT ${projection}::text AS projection,h.owner,c.type,lpad(h.sequence::text,20,'0') AS id,1::bigint AS revision,
        c.link,c."objectType",h.id AS process_id,
        jsonb_build_object('id',lpad(h.sequence::text,20,'0'),'name',c."objectType"||'.'||c.property||' · '||h.sequence,
          'processId',h.id,'property',c.property,'oldState',h.before_values->c.property,'newState',h.after_values->c.property,
          'timestamp',coalesce(h.observed_at,h.happened_at),'recordedAt',h.happened_at,'sequence',h.sequence::text,
          'action',h.action,'requestId',h.request_id,'taskId',h.task_id,'source',h.source,'actor',h.actor,'release',h.release) AS properties
      FROM ${db.schema}.edit_history h JOIN process_releases r ON r.digest=h.release
      JOIN jsonb_to_recordset(${config}::jsonb) AS c(type text,"objectType" text,property text,link text) ON c."objectType"=h.type
      WHERE h.owner=${actor} AND h.before_values->c.property IS DISTINCT FROM h.after_values->c.property
        AND (h.before_values->c.property IS NULL OR jsonb_typeof(h.before_values->c.property) IN('string','null'))
        AND (h.after_values->c.property IS NULL OR jsonb_typeof(h.after_values->c.property) IN('string','null'))
    ), process_view_objects AS (
      SELECT projection,owner,type,id,revision,properties FROM ${base.objects}
      UNION ALL SELECT projection,owner,type,id,revision,properties FROM process_log_rows
    ), process_view_links AS (
      SELECT projection,owner,type,from_type,from_id,to_type,to_id,single_from,single_to FROM ${base.links}
      UNION ALL SELECT projection,owner,link,type,id,"objectType",process_id,true,false FROM process_log_rows
    ) ` };
}
