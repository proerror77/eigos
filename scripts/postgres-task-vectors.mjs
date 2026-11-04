import {parseArgs} from 'node:util';
import {isAbsolute} from 'node:path';
import {existsSync,writeFileSync} from 'node:fs';
import pg from 'pg';

const usage='Usage: node scripts/postgres-task-vectors.mjs --input /private/operation.json [--apply|--readback --expected-preview-digest SHA256 --output /private/new-proof.json [--feature-output /private/new-feature.json]]\nDefault is offline preview. Schema apply requires feature-output; publish-kernel requires pinned feature + expected prior release in the operation. Existing administrator password is read only from the runtime environment. No model, emitter, authority, publisher or Worker is started.';
let values;try{({values}=parseArgs({options:{help:{type:'boolean'},input:{type:'string'},apply:{type:'boolean'},readback:{type:'boolean'},'expected-preview-digest':{type:'string'},output:{type:'string'},'feature-output':{type:'string'}}}));}catch{console.error(usage);process.exit(2);}
if(values.help){console.log(usage);process.exit(0);}
const connect=values.apply||values.readback;
if(!values.input||!isAbsolute(values.input)||values.apply&&values.readback||connect&&(!/^[a-f0-9]{64}$/.test(values['expected-preview-digest']??'')||!values.output||!isAbsolute(values.output))
  ||!connect&&(values.output||values['feature-output']||values['expected-preview-digest'])||values['feature-output']&&!isAbsolute(values['feature-output'])){console.error(usage);process.exit(2);}
let writer,reader,writerErrors,readerErrors,database,pool,poolFailure,started=false,commitAcknowledged=false;
try{
  const {readOwnedBindingFile}=await import('../dist/packages/deployment/postgres-binding.js');
  const {readPostgresVectorIndexOperation,installPostgresEmbeddingExtension,verifyPostgresEmbeddingExtension,installPostgresSemanticKernel,verifyPostgresSemanticKernel}=await import('../dist/packages/deployment/postgres-vector-index.js');
  const {postgresVectorConnectionOptions}=await import('../dist/packages/postgres/vector-extension.js');
  const {observePostgresClient}=await import('../dist/packages/postgres/client-errors.js');
  const {preparePostgresKernel}=await import('../dist/packages/postgres/kernel-runtime.js');
  const {PostgresDatabase}=await import('../dist/packages/postgres/database.js');
  const checked=readPostgresVectorIndexOperation(JSON.parse(readOwnedBindingFile(values.input,65536,true).toString('utf8'))),{operation,binding,preview,previewDigest}=checked;
  if(!connect)console.log(JSON.stringify({...preview,previewDigest},null,2));
  else{
    if(previewDigest!==values['expected-preview-digest'])throw new Error('Reviewed preview differs');
    const schemaApply=values.apply&&operation.action==='prepare-schema';
    if(schemaApply!==!!values['feature-output']||values.readback&&!checked.feature)throw new Error('Exact feature input/output is required for this operation');
    for(const path of [values.output,values['feature-output']].filter(Boolean))if(existsSync(path))throw new Error('Evidence already exists; independently inspect before retry');
    if(values.output===values['feature-output'])throw new Error('Proof and host feature manifest need separate files');
    const connection=postgresVectorConnectionOptions({version:1,kind:'eigos.postgres-vector-operation',target:{host:binding.connection.host,port:binding.connection.port,database:binding.connection.database,
      ca:{path:binding.connection.tls.ca.path,sha256:binding.connection.tls.ca.sha256},proxyUrl:binding.connection.proxyUrl},adminIdentity:operation.adminIdentity,extension:{name:'vector',schema:'extensions',version:'0.8.2'}},process.env);
    let result,feature=checked.feature;
    if(schemaApply){writer=new pg.Client(connection);writerErrors=observePostgresClient(writer);await writer.connect();writerErrors.check();started=true;
      result=await installPostgresEmbeddingExtension(writer,binding,{adminRole:operation.adminIdentity.role,reviewDigest:operation.reviewDigest});commitAcknowledged=true;writerErrors.check();feature=result.feature;}
    reader=new pg.Client(connection);readerErrors=observePostgresClient(reader);await reader.connect();readerErrors.check();
    const verification=await verifyPostgresEmbeddingExtension(reader,binding,feature);readerErrors.check();
    let semanticVerification;
    if(operation.action==='publish-kernel'){
      const kernel=await preparePostgresKernel(undefined,{semanticRetrieval:true});pool=new pg.Pool({...connection,max:1});pool.on('error',error=>{poolFailure??=error;});
      database=new PostgresDatabase(pool,binding.business.schema,binding.authority,{kernel,vectorFeature:feature});
      if(values.apply){started=true;result=await installPostgresSemanticKernel(database,binding,feature,{adminRole:operation.adminIdentity.role,expected:operation.expectedActive.ref,expectedGeneration:operation.expectedActive.generation,reviewDigest:operation.reviewDigest},kernel);commitAcknowledged=true;}
      semanticVerification=await verifyPostgresSemanticKernel(reader,binding,feature,operation.expectedActive,kernel);readerErrors.check();if(poolFailure)throw poolFailure;
    }
    const proof={version:1,status:values.apply?'applied-and-independently-verified':'verified-at-snapshot',previewDigest,action:operation.action,commitAcknowledged,verification,semanticVerification,result,runtimeStarted:false};
    writeFileSync(values.output,JSON.stringify(proof,null,2)+'\n',{mode:0o600,flag:'wx'});
    if(schemaApply)writeFileSync(values['feature-output'],JSON.stringify(feature,null,2)+'\n',{mode:0o600,flag:'wx'});
    console.log(JSON.stringify({status:proof.status,proofWritten:true,featureManifestWritten:!!schemaApply,runtimeStarted:false,embeddingEmitter:'not-configured'}));
  }
}catch(error){
  const cause=readerErrors?.annotate(writerErrors?.annotate(error)??error)??error;
  const code=cause&&typeof cause==='object'&&'code'in cause&&/^[A-Z0-9_]{1,32}$/.test(String(cause.code))?String(cause.code):'TASK_VECTOR_REFUSED';
  console.error(`Task vector operation failed (${code}); ${commitAcknowledged?'a commit was acknowledged':started?'commit outcome may be unknown':'no administration was started'}. Preserve evidence and independently inspect before retry.`);process.exitCode=1;
}finally{
  if(database)await database.close().catch(()=>{process.exitCode=1;});
  for(const [client,watch] of [[reader,readerErrors],[writer,writerErrors]])if(client){try{await client.end();if(watch?.failure)process.exitCode=1;}catch{process.exitCode=1;}finally{watch?.close();}}
}
