import {parseArgs} from 'node:util';
import {isAbsolute} from 'node:path';
import {existsSync} from 'node:fs';
import pg from 'pg';

const usage='Usage: node scripts/postgres-node-migrate.mjs --input /private/node-operation.json [--apply --expected-preview-digest SHA256 --output-directory /private/new-evidence-directory] [--readback --expected-preview-digest SHA256]\nPreview reads frozen private artifacts only. Apply/readback require reviewed admin identity and existing host secrets in the environment. No Relay, publisher or Worker is started.';
let values;
try{({values}=parseArgs({options:{help:{type:'boolean'},input:{type:'string'},apply:{type:'boolean'},readback:{type:'boolean'},'expected-preview-digest':{type:'string'},'output-directory':{type:'string'}}}));}catch{console.error(usage);process.exit(2);}
if(values.help){console.log(usage);process.exit(0);}
if(!values.input||!isAbsolute(values.input)||values.apply&&values.readback||(values.apply||values.readback)&&!/^[a-f0-9]{64}$/.test(values['expected-preview-digest']??'')||values.apply&&(!values['output-directory']||!isAbsolute(values['output-directory']))||!values.apply&&values['output-directory']){console.error(usage);process.exit(2);}
let writer,reader,writerErrors,readerErrors,commitAcknowledged=false;
try{
  const {readOwnedBindingFile,readPinnedPostgresJson,postgresConnectionOptions}=await import('../dist/packages/deployment/postgres-binding.js');
  const {postgresNodeMigrationOperationSchema,previewPostgresNodeMigration,importPostgresNodeMigration,verifyPostgresNodeMigration,writePostgresNodeMigrationEvidence,postgresMigrationWrappingKey}=await import('../dist/packages/deployment/postgres-node-migration.js');
  const {readPostgresHandoffOperation}=await import('../dist/packages/deployment/postgres-handoff.js');
  const {observePostgresClient}=await import('../dist/packages/postgres/client-errors.js');
  const {supabaseProxyOptions}=await import('../dist/packages/postgres/supabase-proxy.js');
  const {digest}=await import('../dist/packages/core/delegation.js');
  const input=postgresNodeMigrationOperationSchema.parse(JSON.parse(readOwnedBindingFile(values.input,65536,true).toString('utf8'))),preview=await previewPostgresNodeMigration(input),previewDigest=digest(preview);
  if(!values.apply&&!values.readback)console.log(JSON.stringify({...preview,previewDigest},null,2));
  else{
    if(values['expected-preview-digest']!==previewDigest||values.apply&&existsSync(values['output-directory']))throw new Error('Reviewed preview changed or evidence destination already exists');
    const handoff=readPostgresHandoffOperation(readPinnedPostgresJson(input.handoffOperation,65536)),binding=handoff.binding;
    const user=process.env.EIGOS_POSTGRES_ADMIN_USER,password=process.env.EIGOS_POSTGRES_ADMIN_PASSWORD;
    if(user!==handoff.operation.adminIdentity.user||!password||password.includes('\0'))throw new Error('Existing administrator credentials differ from the reviewed target');
    const key=await postgresMigrationWrappingKey(input.wrappingKey,process.env),connection={...supabaseProxyOptions(binding.connection.host,binding.connection.port,binding.connection.proxyUrl),...postgresConnectionOptions(binding,{...process.env,EIGOS_POSTGRES_PASSWORD:password}),user};
    let imported;
    if(values.apply){writer=new pg.Client(connection);writerErrors=observePostgresClient(writer);await writer.connect();writerErrors.check();imported=await importPostgresNodeMigration(writer,input,key);writerErrors.check();commitAcknowledged=true;}
    // A fresh, separately owned connection independently reads the committed
    // AEAD/private identities and every ciphertext/TEXT/cursor row.
    reader=new pg.Client(connection);readerErrors=observePostgresClient(reader);await reader.connect();readerErrors.check();const verified=await verifyPostgresNodeMigration(reader,input,key);readerErrors.check();
    if(imported){const evidence=writePostgresNodeMigrationEvidence(input,imported,verified,values['output-directory']);console.log(JSON.stringify(evidence,null,2));}
    else console.log(JSON.stringify({status:verified.status,nodes:verified.nodes.length,serverAcceptance:'not-observed'},null,2));
  }
}catch(error){
  const first=writerErrors?.annotate(error)??error,last=readerErrors?.annotate(first)??first;
  const code=last&&typeof last==='object'&&'code'in last&&/^[A-Z0-9_]{1,32}$/.test(String(last.code))?String(last.code):'NODE_MIGRATION_REFUSED';
  console.error(`Offline node migration failed (${code}); ${commitAcknowledged?'the import commit was acknowledged':'the import outcome may be unknown'}. Inspect node rows and immutable receipts before any manual retry. No service was started.`);process.exitCode=1;
}finally{
  for(const [client,observer] of [[reader,readerErrors],[writer,writerErrors]])if(client)try{await client.end();observer?.check();}catch{console.error('Offline node connection shutdown failed; inspect the target before retrying.');process.exitCode=1;}finally{observer?.close();}
}
