import {parseArgs} from 'node:util';
import {isAbsolute} from 'node:path';
import {existsSync,writeFileSync} from 'node:fs';
import pg from 'pg';

const usage='Usage: node scripts/postgres-vector.mjs --input /private/vector-operation.json [--apply|--readback --expected-preview-digest SHA256 --output /private/new-receipt.json]\nPreview is the default: no credentials or database connection. Apply/readback use existing EIGOS_POSTGRES_ADMIN_USER and EIGOS_POSTGRES_ADMIN_PASSWORD with the reviewed TLS CA. No runtime grants, business tables or embedding provider are configured.';
let values;
try{({values}=parseArgs({options:{help:{type:'boolean'},input:{type:'string'},apply:{type:'boolean'},readback:{type:'boolean'},'expected-preview-digest':{type:'string'},output:{type:'string'}}}));}
catch{console.error(usage);process.exit(2);}
if(values.help){console.log(usage);process.exit(0);}
const connect=values.apply||values.readback;
if(!values.input||!isAbsolute(values.input)||values.apply&&values.readback||connect&&(!/^[a-f0-9]{64}$/.test(values['expected-preview-digest']??'')||!values.output||!isAbsolute(values.output))||!connect&&(values['expected-preview-digest']||values.output)){console.error(usage);process.exit(2);}
let writer,reader,writerErrors,readerErrors,commitAcknowledged=false,administrationStarted=false;
try{
  const {readOwnedBindingFile}=await import('../dist/packages/deployment/postgres-binding.js');
  const {postgresVectorOperationSchema,previewPostgresVector,postgresVectorConnectionOptions,installPostgresVector,verifyPostgresVector}=await import('../dist/packages/postgres/vector-extension.js');
  const {observePostgresClient}=await import('../dist/packages/postgres/client-errors.js');
  const {digest}=await import('../dist/packages/core/delegation.js');
  const input=postgresVectorOperationSchema.parse(JSON.parse(readOwnedBindingFile(values.input,16384,true).toString('utf8')));
  const preview=previewPostgresVector(input),previewDigest=digest(preview);
  if(!connect)console.log(JSON.stringify({...preview,previewDigest},null,2));
  else{
    if(previewDigest!==values['expected-preview-digest'])throw new Error('Reviewed preview differs');
    if(existsSync(values.output))throw new Error('Evidence already exists; inspect it before any retry');
    const connection=postgresVectorConnectionOptions(input,process.env);let installed;
    if(values.apply){
      writer=new pg.Client(connection);writerErrors=observePostgresClient(writer);await writer.connect();writerErrors.check();
      administrationStarted=true;installed=await installPostgresVector(writer,input);commitAcknowledged=true;writerErrors.check();
    }
    // Independently connected, read-only verification of actual committed
    // extension catalog and synthetic operators; no business/model calls.
    reader=new pg.Client(connection);readerErrors=observePostgresClient(reader);await reader.connect();readerErrors.check();
    const verified=await verifyPostgresVector(reader,input);readerErrors.check();
    if(installed&&installed.readback.catalogDigest!==verified.catalogDigest)throw new Error('Independent vector catalog readback differs from the committed observation');
    writeFileSync(values.output,JSON.stringify({version:1,previewDigest,status:installed?.status??'readback-only',commitAcknowledged,verified},null,2)+'\n',{mode:0o600,flag:'wx'});
    console.log(JSON.stringify({status:installed?.status??'readback-only',receiptWritten:true,syntheticOperatorSmoke:'passed',runtimeGrantStatementsIssued:false,semanticRetrieval:'not-configured'}));
  }
}catch(error){
  const first=writerErrors?.annotate(error)??error,last=readerErrors?.annotate(first)??first;
  const code=last&&typeof last==='object'&&'code'in last&&/^[A-Z0-9_]{1,32}$/.test(String(last.code))?String(last.code):'VECTOR_REFUSED';
  console.error(`PostgreSQL vector operation failed (${code}); ${commitAcknowledged?'the extension commit was acknowledged':administrationStarted?'commit outcome may be unknown':'no administrative commit was attempted'}. Inspect the exact target before any manual retry. No runtime grants or embedding calls were made.`);process.exitCode=1;
}finally{
  for(const [client,observer] of [[reader,readerErrors],[writer,writerErrors]])if(client)try{await client.end();observer?.check();}catch{console.error('Vector connection shutdown failed; inspect the target before retrying.');process.exitCode=1;}finally{observer?.close();}
}
