import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { Conflict, NotFound, digest } from '../core/identity.js';
import { Access, type Permission } from './access.js';
import type { Database } from './database.js';
import { Metadata, type PublishedOntology } from './metadata.js';
import { Objects } from './objects.js';

export const indexingInputSchema = z.strictObject({
  source: z.string().min(1).max(80), stream: z.string().min(1).max(128),
  offset: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  mode: z.enum(['batch','stream']), observedAt: z.iso.datetime({offset:true}),
  rows: z.array(z.record(z.string(),z.unknown())).max(1000),
  deleted: z.array(z.string().min(1).max(200)).max(1000).default([]),
});
export type IndexingInput = z.input<typeof indexingInputSchema>;

export async function initializeIndexing(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.index_streams (
    owner text NOT NULL, ontology text NOT NULL, source text NOT NULL, stream text NOT NULL,
    applied_offset bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(owner,ontology,source,stream));
    CREATE TABLE IF NOT EXISTS ${db.schema}.index_transactions (
      id uuid PRIMARY KEY, owner text NOT NULL, ontology text NOT NULL, release text NOT NULL REFERENCES ${db.schema}.releases(digest),
      source text NOT NULL, stream text NOT NULL, offset_value bigint NOT NULL, mode text NOT NULL,
      digest text NOT NULL, input jsonb NOT NULL, scopes jsonb NOT NULL,
      state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','applied','failed')),
      attempts integer NOT NULL DEFAULT 0, error text, submitted_at timestamptz NOT NULL DEFAULT now(), applied_at timestamptz,
      UNIQUE(owner,ontology,source,stream,offset_value));
    CREATE INDEX IF NOT EXISTS index_transactions_queue ON ${db.schema}.index_transactions(state,submitted_at);`);
}

function authorize(access: Access, model: PublishedOntology, name: string) {
  access.definition(model,'datasource',name);
  access.require(model.document.id,'ingest_source' as Permission,`${model.document.id}/datasource/${name}`);
  const source = model.sources.get(name);
  if (!source) throw new NotFound('Datasource mapping is unavailable');
  const provider = model.functions.get(source.function)?.source;
  if (provider) access.source(model,provider);
  return source;
}
function mapRows(model: PublishedOntology, input: z.output<typeof indexingInputSchema>) {
  const source = model.sources.get(input.source);
  if (!source) throw new NotFound('Datasource mapping is unavailable');
  const type = model.object(source.objectType);
  const rows = input.rows.map(row => {
    const properties = Object.fromEntries(Object.entries(source.properties).map(([field,path]) => [field,path.split('.').reduce<unknown>((value,key) => value && typeof value === 'object' ? Reflect.get(value,key) : undefined,row)]));
    const id = properties[type.primaryKey];
    if (typeof id !== 'string' || !id) throw new Conflict('Datasource row requires its declared primary key');
    const ref = {type:type.apiName,id};
    return {ref,properties:model.parseObject(ref,properties)};
  });
  const identifiers = [...rows.map(row=>row.ref.id),...input.deleted];
  if (new Set(identifiers).size !== identifiers.length) throw new Conflict('A source transaction must contain each object once');
  return [...rows,...input.deleted.map(id=>({ref:{type:type.apiName,id},properties:null}))];
}

export class Indexing {
  constructor(private readonly db: Database, private readonly metadata = new Metadata(db)) {}
  async submit(access: Access, model: PublishedOntology, raw: unknown) {
    const input = indexingInputSchema.parse(raw);
    if (JSON.stringify(input).length > 2_000_000) throw new Conflict('Source transaction exceeds the payload limit');
    if (model.scenario) throw new Conflict('Indexing requires a live publication');
    await access.refresh(); authorize(access,model,input.source); mapRows(model,input);
    const fingerprint = digest({input,release:model.release});
    return this.db.transaction(async client => {
      await this.db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',['publication:'+model.document.id],client);
      if ((await this.metadata.active(model.document.id,client)).release !== model.release) throw new Conflict('Indexing publication changed');
      await this.db.query(`INSERT INTO ${this.db.schema}.index_streams(owner,ontology,source,stream) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[access.principal.owner,model.document.id,input.source,input.stream],client);
      const id = randomUUID();
      await this.db.query(`INSERT INTO ${this.db.schema}.index_transactions(id,owner,ontology,release,source,stream,offset_value,mode,digest,input,scopes)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(owner,ontology,source,stream,offset_value) DO NOTHING`,[id,access.principal.owner,model.document.id,model.release,input.source,input.stream,input.offset,input.mode,fingerprint,input,JSON.stringify(access.principal.scopes)],client);
      const row = (await this.db.query(`SELECT id,digest,state FROM ${this.db.schema}.index_transactions WHERE owner=$1 AND ontology=$2 AND source=$3 AND stream=$4 AND offset_value=$5`,[access.principal.owner,model.document.id,input.source,input.stream,input.offset],client)).rows[0]!;
      if (row.digest !== fingerprint) throw new Conflict('Source offset already contains another transaction');
      await access.refresh(client);
      await this.db.query("SELECT pg_notify('eigos_indexing','ready')",[],client);
      return {id:String(row.id),state:String(row.state),offset:input.offset,provenance:'authenticated_producer'};
    });
  }
  async inspect(access: Access, model: PublishedOntology, id: string) {
    z.uuid().parse(id); await access.refresh();
    const row = (await this.db.query(`SELECT t.id,t.source,t.stream,t.offset_value::text AS offset,t.mode,t.state,t.attempts,t.error,t.submitted_at,t.applied_at,t.release,t.digest,s.applied_offset::text
      FROM ${this.db.schema}.index_transactions t JOIN ${this.db.schema}.index_streams s USING(owner,ontology,source,stream)
      WHERE t.owner=$1 AND t.ontology=$2 AND t.id=$3`,[access.principal.owner,model.document.id,id])).rows[0];
    if (!row) throw new NotFound('Index transaction is unavailable');
    authorize(access,model,row.source); await access.refresh();
    return {...row,provenance:'authenticated_producer'};
  }
  async retry(access: Access, model: PublishedOntology, id: string) {
    await this.inspect(access,model,id);
    await this.db.transaction(async client => {
      await access.refresh(client);
      const row=(await this.db.query(`SELECT * FROM ${this.db.schema}.index_transactions WHERE id=$1 AND owner=$2 FOR UPDATE`,[id,access.principal.owner],client)).rows[0];
      if (!row || row.state !== 'failed') throw new Conflict('Only failed index transactions can retry');
      const input=indexingInputSchema.parse(row.input);
      authorize(access,model,input.source); mapRows(model,input);
      if ((await this.metadata.active(model.document.id,client,true)).release !== model.release) throw new Conflict('Indexing publication changed');
      // Original input/digest remain immutable; a retry is only allowed for its pinned publication.
      if (row.release !== model.release) throw new Conflict('Retry the original publication or submit a new stream for the new publication');
      await this.db.query(`UPDATE ${this.db.schema}.index_transactions SET state='pending',error=NULL WHERE id=$1`,[id],client);
      await this.db.query("SELECT pg_notify('eigos_indexing','ready')",[],client);
    });
    return this.inspect(access,model,id);
  }
  async runOne(): Promise<boolean> {
    let selected: string | undefined;
    try {
      return await this.db.transaction(async client => {
        const row = (await this.db.query(`SELECT t.* FROM ${this.db.schema}.index_transactions t
          JOIN ${this.db.schema}.index_streams s USING(owner,ontology,source,stream)
          WHERE t.state='pending' AND t.offset_value=s.applied_offset+1
          ORDER BY t.submitted_at FOR UPDATE OF t,s SKIP LOCKED LIMIT 1`,[],client)).rows[0];
        if (!row) return false;
        selected=String(row.id);
        const model=await this.metadata.get(row.release,client), access=await Access.load(this.db,{owner:row.owner,scopes:row.scopes},client);
        const input=indexingInputSchema.parse(row.input); authorize(access,model,input.source);
        const graph=new Objects(this.db,model,access,client);
        await graph.lockWrites();
        // Objects resolves source values with user edits and journals changes in this transaction.
        const batch=mapRows(model,input);
        await (graph.ingestBatch as (rows: typeof batch, source: string, observedAt: string)=>Promise<void>)(batch,input.source,input.observedAt);
        await access.refresh(client);
        await this.db.query(`UPDATE ${this.db.schema}.index_streams SET applied_offset=$5,updated_at=now() WHERE owner=$1 AND ontology=$2 AND source=$3 AND stream=$4`,[row.owner,row.ontology,row.source,row.stream,input.offset],client);
        await this.db.query(`UPDATE ${this.db.schema}.index_transactions SET state='applied',attempts=attempts+1,error=NULL,applied_at=now() WHERE id=$1`,[row.id],client);
        return true;
      });
    } catch (error) {
      if (!selected) throw error;
      await this.db.query(`UPDATE ${this.db.schema}.index_transactions SET state='failed',attempts=attempts+1,error=$2 WHERE id=$1 AND state='pending'`,[selected,error instanceof Error ? error.name : 'IndexingError']);
      return true;
    }
  }
  async run(signal: AbortSignal) {
    const listener=await this.db.pool.connect();
    let wake: (()=>void)|undefined;
    listener.on('notification',()=>wake?.());
    const abort=()=>wake?.(); signal.addEventListener('abort',abort);
    try {
      await listener.query('LISTEN eigos_indexing');
      while (!signal.aborted) {
        if (await this.runOne()) continue;
        await Promise.race([new Promise<void>(resolve=>{wake=resolve;}),delay(1000)]);
      }
    } finally {
      signal.removeEventListener('abort',abort);
      await listener.query('UNLISTEN eigos_indexing'); listener.release();
    }
  }
}
