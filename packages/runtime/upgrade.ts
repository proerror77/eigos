import { Ontology } from '../ontology/model.js';
import { Database } from './database.js';
import { resource, type Requirement } from './access.js';

/** Offline, in-place upgrade of the existing schema. No database or task store is created. */
export async function upgradePublicationStorage(db: Database) {
  const columns = await db.query(`SELECT attname FROM pg_attribute WHERE attrelid=to_regclass($1) AND attnum>0 AND NOT attisdropped`, [`${db.schema}.objects`]);
  if (!columns.rowCount) { await db.initialize(); return; }
  const legacy = !columns.rows.some(row => row.attname === 'projection');
  if (legacy) await db.transaction(async client => {
    await db.query(`LOCK TABLE ${db.schema}.objects,${db.schema}.links,${db.schema}.tasks IN ACCESS EXCLUSIVE MODE`, [], client);
    if ((await db.query(`SELECT 1 FROM ${db.schema}.tasks WHERE state IN('submitted','working','input-required') LIMIT 1`, [], client)).rowCount) throw new Error('Drain unfinished tasks before upgrading storage');
    const active = (await db.query(`SELECT release FROM ${db.schema}.ontology`, [], client)).rows;
    if (active.length !== 1) throw new Error('Legacy rows require one existing ontology authority');
    for (const table of ['links', 'objects']) {
      const constraints = (await db.query(`SELECT conname FROM pg_constraint WHERE conrelid=$1::regclass AND contype IN('p','f')`, [`${db.schema}.${table}`], client)).rows;
      for (const row of constraints) await db.query(`ALTER TABLE ${db.schema}.${table} DROP CONSTRAINT "${String(row.conname).replaceAll('"', '""')}"`, [], client);
      await db.query(`ALTER TABLE ${db.schema}.${table} ADD COLUMN projection text`, [], client);
      await db.query(`UPDATE ${db.schema}.${table} SET projection=$1`, [active[0]!.release], client);
      await db.query(`ALTER TABLE ${db.schema}.${table} ALTER COLUMN projection SET NOT NULL`, [], client);
    }
    await db.query(`ALTER TABLE ${db.schema}.objects ADD PRIMARY KEY(projection,owner,type,id);
      ALTER TABLE ${db.schema}.links ADD PRIMARY KEY(projection,owner,type,from_type,from_id,to_type,to_id);
      ALTER TABLE ${db.schema}.links ADD FOREIGN KEY(projection,owner,from_type,from_id) REFERENCES ${db.schema}.objects(projection,owner,type,id);
      ALTER TABLE ${db.schema}.links ADD FOREIGN KEY(projection,owner,to_type,to_id) REFERENCES ${db.schema}.objects(projection,owner,type,id);
      DROP INDEX IF EXISTS ${db.schema}.links_reverse;
      DROP INDEX IF EXISTS ${db.schema}.links_single_from;
      DROP INDEX IF EXISTS ${db.schema}.links_single_to;`, [], client);
  });
  await db.initialize();
  const releases = (await db.query(`SELECT digest,body FROM ${db.schema}.releases WHERE projection IS NULL ORDER BY created_at`)).rows;
  if (!releases.length) return;
  const current = (await db.query(`SELECT release FROM ${db.schema}.ontology`)).rows[0]!.release;
  await db.transaction(async client => {
    const objects = (await db.query(`SELECT owner,type,id,revision,properties FROM ${db.schema}.objects WHERE projection=$1`, [current], client)).rows;
    const links = (await db.query(`SELECT owner,type,from_type,from_id,to_type,to_id FROM ${db.schema}.links WHERE projection=$1`, [current], client)).rows;
    for (const release of releases) {
      const model = new Ontology(release.body);
      if (model.digest !== release.digest) throw new Error('Stored definition differs from its original fingerprint');
      const rows = objects.filter(row => model.objects.has(row.type)).map(row => ({ ...row, properties: model.parseObject({ type: row.type, id: row.id },
        Object.fromEntries(Object.entries(row.properties).filter(([name]) => model.object(row.type).properties[name]))) }));
      for (let i = 0; i < rows.length; i += 500) await db.query(`INSERT INTO ${db.schema}.objects(projection,owner,type,id,revision,properties)
        SELECT $1,owner,type,id,revision,properties FROM jsonb_to_recordset($2::jsonb) AS r(owner text,type text,id text,revision bigint,properties jsonb)
        ON CONFLICT(projection,owner,type,id) DO UPDATE SET properties=excluded.properties`, [release.digest, JSON.stringify(rows.slice(i, i + 500))], client);
      const edges = links.filter(row => model.links.has(row.type)).map(row => ({ ...row, single_from: model.links.get(row.type)!.from.cardinality === 'one', single_to: model.links.get(row.type)!.to.cardinality === 'one' }));
      for (let i = 0; i < edges.length; i += 500) await db.query(`INSERT INTO ${db.schema}.links(projection,owner,type,from_type,from_id,to_type,to_id,single_from,single_to)
        SELECT $1,owner,type,from_type,from_id,to_type,to_id,single_from,single_to FROM jsonb_to_recordset($2::jsonb) AS r(owner text,type text,from_type text,from_id text,to_type text,to_id text,single_from boolean,single_to boolean) ON CONFLICT DO NOTHING`, [release.digest, JSON.stringify(edges.slice(i, i + 500))], client);
      await db.query(`UPDATE ${db.schema}.releases SET definition_digest=$2,projection=$1,runtime_id='legacy-readonly',bindings='{"functions":{},"sources":{}}',state=$3 WHERE digest=$1`, [release.digest, model.digest, release.digest === current ? 'active' : 'retired'], client);
      const requirements: Requirement[] = model.document.objectTypes.flatMap(type => [
        { ontology: model.document.id, permission: 'view_objects' as const, resource: resource(model.document.id, 'object', type.apiName) },
        ...Object.keys(type.properties).map(name => ({ ontology: model.document.id, permission: 'view_property' as const, resource: resource(model.document.id, 'property', `${type.apiName}/${name}`) })),
      ]);
      await db.query(`UPDATE ${db.schema}.tasks SET result_permissions=$2 WHERE release=$1 AND result_permissions IS NULL`, [release.digest, JSON.stringify(requirements)], client);
    }
  });
}
