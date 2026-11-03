import type {Client} from 'pg';
import {digest} from '../core/delegation.js';
import {postgresBusinessSchema} from './runtime-transaction.js';

const prefix='__SCHEMA__';
const guard=`CREATE OR REPLACE FUNCTION ${prefix}.eigos_guard_relay_node_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
BEGIN
  IF TG_OP='DELETE' THEN
    IF TG_TABLE_NAME='eigos_relay_node_retained' THEN
      IF OLD.expires_at<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint THEN RETURN OLD; END IF;
    END IF;
    RAISE EXCEPTION 'Immutable Relay node history';
  END IF;
  IF TG_TABLE_NAME IN('eigos_relay_node_state','eigos_relay_node_retained') THEN RAISE EXCEPTION 'Immutable Relay node history'; END IF;
  IF TG_TABLE_NAME='eigos_relay_node_outbox' THEN
    IF NEW.node_id IS DISTINCT FROM OLD.node_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.recipient IS DISTINCT FROM OLD.recipient OR NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.content_digest IS DISTINCT FROM OLD.content_digest OR NEW.envelope IS DISTINCT FROM OLD.envelope OR NEW.__eigos_rowid IS DISTINCT FROM OLD.__eigos_rowid THEN RAISE EXCEPTION 'Immutable Relay node history'; END IF;
  ELSE
    IF NEW.node_id IS DISTINCT FROM OLD.node_id OR NEW.sender IS DISTINCT FROM OLD.sender OR NEW.id IS DISTINCT FROM OLD.id OR NEW.digest IS DISTINCT FROM OLD.digest OR NEW.sender_card IS DISTINCT FROM OLD.sender_card OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.__eigos_rowid IS DISTINCT FROM OLD.__eigos_rowid OR(NEW.envelope IS NOT NULL AND NEW.envelope IS DISTINCT FROM OLD.envelope) OR(OLD.state<>'pending' AND NEW.state IS DISTINCT FROM OLD.state) THEN RAISE EXCEPTION 'Immutable Relay node history'; END IF;
  END IF;
  RETURN NEW;
END
$body$`;
const tables=['eigos_relay_node_state','eigos_relay_node_outbox','eigos_relay_node_inbox','eigos_relay_node_retained'] as const;
const sequences=['eigos_relay_node_outbox_rowid_seq','eigos_relay_node_inbox_rowid_seq','eigos_relay_node_retained_rowid_seq'] as const;
const ddl=[...sequences.map(name=>`CREATE SEQUENCE IF NOT EXISTS ${prefix}.${name} AS BIGINT`),
  `CREATE TABLE IF NOT EXISTS ${prefix}.eigos_relay_node_state(node_id TEXT PRIMARY KEY,base_url TEXT NOT NULL,agent_id TEXT NOT NULL,signed_card TEXT NOT NULL,credentials TEXT NOT NULL,import_digest TEXT)`,
  `CREATE TABLE IF NOT EXISTS ${prefix}.eigos_relay_node_outbox(node_id TEXT NOT NULL,id TEXT NOT NULL,recipient TEXT NOT NULL,connection_id TEXT NOT NULL,content_digest TEXT NOT NULL,envelope TEXT NOT NULL,receipt TEXT,__eigos_rowid BIGINT NOT NULL DEFAULT nextval('${prefix}.eigos_relay_node_outbox_rowid_seq'::regclass),UNIQUE(node_id,__eigos_rowid),PRIMARY KEY(node_id,id))`,
  `CREATE TABLE IF NOT EXISTS ${prefix}.eigos_relay_node_inbox(node_id TEXT NOT NULL,sender TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,envelope TEXT,sender_card TEXT NOT NULL,state TEXT NOT NULL,reason TEXT,expires_at BIGINT NOT NULL,__eigos_rowid BIGINT NOT NULL DEFAULT nextval('${prefix}.eigos_relay_node_inbox_rowid_seq'::regclass),UNIQUE(node_id,__eigos_rowid),PRIMARY KEY(node_id,sender,id))`,
  `CREATE INDEX IF NOT EXISTS eigos_relay_node_pending ON ${prefix}.eigos_relay_node_inbox(node_id,state,expires_at)`,
  `CREATE TABLE IF NOT EXISTS ${prefix}.eigos_relay_node_retained(node_id TEXT NOT NULL,sender TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,envelope TEXT NOT NULL,sender_card TEXT NOT NULL,expires_at BIGINT NOT NULL,__eigos_rowid BIGINT NOT NULL DEFAULT nextval('${prefix}.eigos_relay_node_retained_rowid_seq'::regclass),UNIQUE(node_id,__eigos_rowid),PRIMARY KEY(node_id,sender,id))`,
  ...sequences.map((sequence,index)=>`ALTER SEQUENCE ${prefix}.${sequence} OWNED BY ${prefix}.${tables[index+1]}.__eigos_rowid`),guard,
  ...tables.flatMap(table=>[`DROP TRIGGER IF EXISTS ${table}_immutable ON ${prefix}.${table}`,`CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${prefix}.${table} FOR EACH ROW EXECUTE FUNCTION ${prefix}.eigos_guard_relay_node_immutable()`]),
];
/** Exact reviewed post-import extension. No other table/function/trigger is
 * covered. The original four messaging tables remain in the source inventory.
 * The host binds this contract to its separate immutable schema receipt and
 * independently checks the physical catalog before runtime activation. */
export const POSTGRES_MESSAGING_NODE_SCHEMA_V1=Object.freeze({version:1 as const,tables:[...tables],sequences:[...sequences],functions:['eigos_guard_relay_node_immutable()'],triggers:tables.map(table=>({table,name:`${table}_immutable`})),indexes:[
  ...tables.map(table=>`${table}_pkey`),...tables.slice(1).map(table=>`${table}_node_id___eigos_rowid_key`),'eigos_relay_node_pending',
],ddl:[...ddl],ddlDigest:digest(ddl),originalTables:['messaging_grants','messaging_messages','messaging_requests','messaging_node_leases']});

/** Explicit migration-administrator operation only. Gateway startup and
 * request paths never call this function or execute CREATE/GRANT. Runtime
 * roles must lack schema creation privileges. Existing communication metadata
 * must already be imported and covered by the original snapshot receipt. */
export async function installPostgresMessagingStorage(client:Client):Promise<void>{
  const schema=postgresBusinessSchema(client),q=`"${schema}"`;
  for(const table of POSTGRES_MESSAGING_NODE_SCHEMA_V1.originalTables)await client.query(`SELECT 1 FROM ${q}."${table}" LIMIT 0`);
  for(const statement of ddl)await client.query(statement.replaceAll(prefix,q));
}

type Column={name:string;type:'text'|'bigint';nullable?:true;sequence?:string};
const column=(name:string,type:Column['type']='text',nullable?:true):Column=>({name,type,...(nullable?{nullable}:{})});
const columns:Record<(typeof tables)[number],Column[]>={
  eigos_relay_node_state:[column('node_id'),column('base_url'),column('agent_id'),column('signed_card'),column('credentials'),column('import_digest','text',true)],
  eigos_relay_node_outbox:[column('node_id'),column('id'),column('recipient'),column('connection_id'),column('content_digest'),column('envelope'),column('receipt','text',true),{...column('__eigos_rowid','bigint'),sequence:sequences[0]}],
  eigos_relay_node_inbox:[column('node_id'),column('sender'),column('id'),column('digest'),column('envelope','text',true),column('sender_card'),column('state'),column('reason','text',true),column('expires_at','bigint'),{...column('__eigos_rowid','bigint'),sequence:sequences[1]}],
  eigos_relay_node_retained:[column('node_id'),column('sender'),column('id'),column('digest'),column('envelope'),column('sender_card'),column('expires_at','bigint'),{...column('__eigos_rowid','bigint'),sequence:sequences[2]}],
};
const sqlText=(value:unknown)=>String(value).replaceAll('"','').replace(/\s+/g,' ').trim().toLowerCase();
const schemaFailure=(part:string):never=>{throw new Error(`PostgreSQL Relay node schema contract differs: ${part}`);};
const exact=(actual:unknown,expected:unknown,part:string)=>{if(digest(actual)!==digest(expected))schemaFailure(part);};

/** Read-only physical verification for the host's existing pinned snapshot.
 * No BEGIN, DDL, role grant, schema creation or business-client fabrication.
 * A receipt alone cannot authorize different expressions/guards or extras. */
export async function assertPostgresMessagingStorageSchema(client:Client,schema:string):Promise<void>{
  if(!/^eigos_business_[a-z0-9_]{1,40}$/.test(schema)||client.getTransactionStatus()!=='T'||client.pipeline!==false)throw new Error('Relay node schema verification requires the existing non-pipelined PostgreSQL snapshot');
  const catalog=await client.query(`SELECT c.oid::text,c.relname,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,c.relispartition,c.reloptions,c.reltablespace::text,c.relreplident
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname LIKE 'eigos_relay_node_%' ORDER BY c.relname`,[schema]);
  const expectedRelations=[...tables,...sequences,...POSTGRES_MESSAGING_NODE_SCHEMA_V1.indexes].sort();exact(catalog.rows.map(row=>row.relname),expectedRelations,'relation inventory');
  const byName=new Map(catalog.rows.map(row=>[String(row.relname),row]));
  const tableOids=tables.map(table=>{
    const row=byName.get(table);if(!row||row.relkind!=='r'||row.relpersistence!=='p'||row.relrowsecurity||row.relforcerowsecurity||row.relispartition||row.reloptions?.length||row.reltablespace!=='0'||row.relreplident!=='d')return schemaFailure(`table ${table}`);return row.oid as string;
  });
  const tableRows=await client.query(`SELECT c.oid::text,c.relname,a.attnum,a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attidentity,a.attgenerated,a.attisdropped,
      a.attcollation::text,pg_catalog.pg_get_expr(d.adbin,d.adrelid,false) AS expression,d.oid::text AS default_oid
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE c.oid=ANY($1::oid[]) ORDER BY c.relname,a.attnum`,[tableOids]);
  const defaultCollation=String((await client.query(`SELECT 'pg_catalog."default"'::regcollation::oid::text AS oid`)).rows[0]?.oid);
  for(const table of tables){
    const actual=tableRows.rows.filter(row=>row.relname===table),expected=columns[table];if(actual.length!==expected.length)schemaFailure(`columns ${table}`);
    for(const [index,entry] of expected.entries()){
      const row=actual[index];if(!row||Number(row.attnum)!==index+1||row.attname!==entry.name||row.type!==entry.type||row.attnotnull===!!entry.nullable||row.attidentity!==''||row.attgenerated!==''||row.attisdropped||row.attcollation!==(entry.type==='text'?defaultCollation:'0'))schemaFailure(`column ${table}.${entry.name}`);
      if(entry.sequence){
        // pg_get_expr omits the schema when the same sequence is visible on
        // search_path. Both renderings still require the exact dependency OID
        // below, so a similarly named sequence/function cannot substitute.
        const expression=sqlText(row.expression).replace('pg_catalog.nextval','nextval');
        if(![`nextval('${schema}.${entry.sequence}'::regclass)`,`nextval('${entry.sequence}'::regclass)`].includes(expression))schemaFailure(`default ${table}.${entry.name}`);
        const dependencies=await client.query(`SELECT d.refclassid::regclass::text AS kind,d.refobjid::text AS id,d.refobjsubid FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_attrdef'::regclass AND d.objid=$1::oid AND d.deptype='n' AND d.refclassid IN('pg_catalog.pg_class'::regclass,'pg_catalog.pg_proc'::regclass)`,[row.default_oid]);
        const classRows=dependencies.rows.filter(value=>['pg_class','pg_catalog.pg_class'].includes(value.kind));exact(classRows.map(value=>value.id),[byName.get(entry.sequence)!.oid],`default sequence ${table}`);
        const functionRows=dependencies.rows.filter(value=>['pg_proc','pg_catalog.pg_proc'].includes(value.kind));
        const nextval=String((await client.query(`SELECT 'pg_catalog.nextval(regclass)'::regprocedure::oid::text AS oid`)).rows[0]?.oid);if(functionRows.some(value=>value.id!==nextval))schemaFailure(`default function ${table}`);
      }else if(row.expression!==null||row.default_oid!==null)schemaFailure(`unexpected default ${table}.${entry.name}`);
    }
  }
  const constraints=await client.query(`SELECT c.conrelid::text,c.conname,c.contype,c.convalidated,c.condeferrable,c.condeferred,c.conkey::smallint[] AS keys,pg_catalog.pg_get_constraintdef(c.oid,false) AS definition FROM pg_catalog.pg_constraint c WHERE c.conrelid=ANY($1::oid[]) ORDER BY c.conname`,[tableOids]);
  const indexes=await client.query(`SELECT i.indrelid::text,c.relname,c.relkind,am.amname,i.indisunique,i.indisprimary,i.indisvalid,i.indisready,i.indislive,i.indnkeyatts,i.indnatts,i.indkey::smallint[] AS keys,i.indpred IS NULL AS no_predicate,i.indexprs IS NULL AS no_expression,pg_catalog.pg_get_indexdef(i.indexrelid) AS definition FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=c.relam WHERE i.indrelid=ANY($1::oid[]) ORDER BY c.relname`,[tableOids]);
  const expectedConstraints:Record<string,{table:string;kind:string;fields:string[]}>={},expectedIndexes:Record<string,{table:string;unique:boolean;primary:boolean;fields:string[]}>={};
  for(const table of tables){const fields=table==='eigos_relay_node_state'?['node_id']:table==='eigos_relay_node_outbox'?['node_id','id']:['node_id','sender','id'];expectedConstraints[`${table}_pkey`]={table,kind:'p',fields};expectedIndexes[`${table}_pkey`]={table,unique:true,primary:true,fields};
    if(table!=='eigos_relay_node_state'){const name=`${table}_node_id___eigos_rowid_key`;expectedConstraints[name]={table,kind:'u',fields:['node_id','__eigos_rowid']};expectedIndexes[name]={table,unique:true,primary:false,fields:['node_id','__eigos_rowid']};}
  }
  expectedIndexes.eigos_relay_node_pending={table:'eigos_relay_node_inbox',unique:false,primary:false,fields:['node_id','state','expires_at']};
  exact(constraints.rows.map(row=>row.conname),Object.keys(expectedConstraints).sort(),'constraint inventory');
  for(const row of constraints.rows){const expected=expectedConstraints[row.conname]!;const keys=expected.fields.map(name=>columns[expected.table as keyof typeof columns].findIndex(column=>column.name===name)+1);if(row.conrelid!==byName.get(expected.table)!.oid||row.contype!==expected.kind||!row.convalidated||row.condeferrable||row.condeferred)schemaFailure(`constraint ${row.conname}`);exact(row.keys,keys,`constraint keys ${row.conname}`);
    const definition=`${expected.kind==='p'?'primary key':'unique'} (${expected.fields.join(', ')})`;if(sqlText(row.definition)!==definition)schemaFailure(`constraint expression ${row.conname}`);
  }
  exact(indexes.rows.map(row=>row.relname),Object.keys(expectedIndexes).sort(),'index inventory');
  for(const row of indexes.rows){const expected=expectedIndexes[row.relname]!;if(row.indrelid!==byName.get(expected.table)!.oid||row.relkind!=='i'||row.amname!=='btree'||row.indisunique!==expected.unique||row.indisprimary!==expected.primary||!row.indisvalid||!row.indisready||!row.indislive||!row.no_predicate||!row.no_expression||Number(row.indnkeyatts)!==expected.fields.length||Number(row.indnatts)!==expected.fields.length)schemaFailure(`index ${row.relname}`);
    exact(row.keys,expected.fields.map(name=>columns[expected.table as keyof typeof columns].findIndex(column=>column.name===name)+1),`index keys ${row.relname}`);
    if(sqlText(row.definition)!==`create ${expected.unique?'unique ':''}index ${row.relname} on ${schema}.${expected.table} using btree (${expected.fields.join(', ')})`)schemaFailure(`index expression ${row.relname}`);
  }
  const sequenceRows=await client.query(`SELECT c.oid::text,c.relname,c.relkind,c.relpersistence,s.seqtypid::regtype::text AS type,s.seqstart::text,s.seqincrement::text,s.seqmax::text,s.seqmin::text,s.seqcache::text,s.seqcycle FROM pg_catalog.pg_class c JOIN pg_catalog.pg_sequence s ON s.seqrelid=c.oid WHERE c.oid=ANY($1::oid[]) ORDER BY c.relname`,[sequences.map(sequence=>byName.get(sequence)!.oid)]);
  exact(sequenceRows.rows.map(row=>row.relname),[...sequences].sort(),'sequence inventory');
  for(const row of sequenceRows.rows){if(row.relkind!=='S'||row.relpersistence!=='p'||row.type!=='bigint'||row.seqstart!=='1'||row.seqincrement!=='1'||row.seqmax!=='9223372036854775807'||row.seqmin!=='1'||row.seqcache!=='1'||row.seqcycle)schemaFailure(`sequence ${row.relname}`);
    const index=sequences.findIndex(sequence=>sequence===row.relname),table=tables[index+1]!,attnum=columns[table].findIndex(column=>column.name==='__eigos_rowid')+1;
    const owners=await client.query(`SELECT refobjid::text,refobjsubid,deptype FROM pg_catalog.pg_depend WHERE classid='pg_catalog.pg_class'::regclass AND objid=$1::oid AND refclassid='pg_catalog.pg_class'::regclass AND deptype IN('a','i')`,[row.oid]);exact(owners.rows,[{refobjid:byName.get(table)!.oid,refobjsubid:attnum,deptype:'a'}],`sequence ownership ${row.relname}`);
  }
  const functions=await client.query(`SELECT p.oid::text,p.proname,p.pronargs,p.prokind,p.provolatile,p.prosecdef,p.proisstrict,p.proretset,p.proleakproof,p.proparallel,p.proconfig,p.prosrc,p.prorettype::regtype::text AS result,l.lanname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE n.nspname=$1 AND p.proname LIKE 'eigos_guard_relay_node_%' ORDER BY p.oid`,[schema]);
  const fn=functions.rows[0];if(functions.rowCount!==1||!fn||fn.proname!=='eigos_guard_relay_node_immutable'||Number(fn.pronargs)!==0||fn.prokind!=='f'||fn.provolatile!=='v'||fn.prosecdef||fn.proisstrict||fn.proretset||fn.proleakproof||fn.proparallel!=='u'||fn.result!=='trigger'||fn.lanname!=='plpgsql'||String(fn.prosrc).trim()!==guard.split('$body$')[1]!.trim())schemaFailure('guard function body/flags');exact(fn.proconfig,['search_path=pg_catalog'],'guard function search_path');
  const triggers=await client.query(`SELECT t.tgrelid::text,t.tgname,t.tgfoid::text,t.tgtype,t.tgenabled,t.tgisinternal,t.tgconstraint::text,t.tgdeferrable,t.tginitdeferred,t.tgnargs,t.tgargs,t.tgqual IS NULL AS no_qual,t.tgattr::smallint[] AS attrs FROM pg_catalog.pg_trigger t WHERE t.tgrelid=ANY($1::oid[]) ORDER BY t.tgname`,[tableOids]);
  exact(triggers.rows.map(row=>row.tgname),tables.map(table=>`${table}_immutable`).sort(),'trigger inventory');
  for(const row of triggers.rows){const table=tables.find(table=>`${table}_immutable`===row.tgname)!;if(row.tgrelid!==byName.get(table)!.oid||row.tgfoid!==fn.oid||Number(row.tgtype)!==27||row.tgenabled!=='O'||row.tgisinternal||row.tgconstraint!=='0'||row.tgdeferrable||row.tginitdeferred||Number(row.tgnargs)!==0||!row.no_qual||!Buffer.isBuffer(row.tgargs)||row.tgargs.length!==0)schemaFailure(`trigger ${row.tgname}`);exact(row.attrs,[],`trigger attributes ${row.tgname}`);}
  const extra=(await client.query(`SELECT (SELECT count(*) FROM pg_catalog.pg_policy WHERE polrelid=ANY($1::oid[]))+(SELECT count(*) FROM pg_catalog.pg_rewrite WHERE ev_class=ANY($1::oid[])) AS n`,[tableOids])).rows[0];if(Number(extra?.n)!==0)schemaFailure('unexpected table policy/rule');
  const types=await client.query(`SELECT t.oid::text,t.typname,t.typtype,t.typcategory,t.typrelid::text,t.typelem::text FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=$1 AND(t.typname LIKE 'eigos_relay_node_%' OR t.typname LIKE '\\_eigos_relay_node_%') ORDER BY t.typname`,[schema]);
  exact(types.rows.map(row=>row.typname),tables.flatMap(table=>[table,`_${table}`]).sort(),'implicit row-type inventory');
  for(const table of tables){const row=types.rows.find(row=>row.typname===table);const array=types.rows.find(row=>row.typname===`_${table}`);if(!row||row.typtype!=='c'||row.typrelid!==byName.get(table)!.oid||row.typelem!=='0'||!array||array.typtype!=='b'||array.typcategory!=='A'||array.typrelid!=='0'||array.typelem!==row.oid)schemaFailure(`row type ${table}`);}
  if(client.getTransactionStatus()!=='T')throw new Error('Relay node schema verification lost its caller snapshot');
}
