import {parseArgs} from 'node:util';
import {isAbsolute} from 'node:path';
import {writeFileSync,existsSync} from 'node:fs';
import pg from 'pg';

const usage='Usage: node scripts/postgres-primary-handoff.mjs --input /private/reviewed-operation.json [--apply --expected-preview-digest SHA256 --output /private/new-receipt.json]\nApply reads EIGOS_POSTGRES_ADMIN_USER and EIGOS_POSTGRES_ADMIN_PASSWORD from the host environment; activation readback also requires EIGOS_POSTGRES_PASSWORD. Preview reads no credentials and connects to no database.';
let values;
try{({values}=parseArgs({options:{help:{type:'boolean'},input:{type:'string'},apply:{type:'boolean'},'expected-preview-digest':{type:'string'},output:{type:'string'}}}));}
catch{console.error(usage);process.exit(2);}
if(values.help){console.log(usage);process.exit(0);}
if(!values.input||!isAbsolute(values.input)||values.apply&&(!/^[a-f0-9]{64}$/.test(values['expected-preview-digest']??'')||!values.output||!isAbsolute(values.output))||!values.apply&&(values.output||values['expected-preview-digest'])){console.error(usage);process.exit(2);}
let admin,runtime,readback,adminErrors,runtimeErrors,readbackErrors,applied=false;
try{
  const {readOwnedBindingFile,readPostgresBinding,postgresConnectionOptions}=await import('../dist/packages/deployment/postgres-binding.js');
  const {previewPostgresHandoff,postgresHandoffOperationSchema,preparePostgresRuntimeSchema,verifyPreparedPostgresRuntimeSchema,activatePostgresPrimary,verifyPostgresHandoffRuntime}=await import('../dist/packages/deployment/postgres-handoff.js');
  const {supabaseProxyOptions}=await import('../dist/packages/postgres/supabase-proxy.js');
  const {observePostgresClient}=await import('../dist/packages/postgres/client-errors.js');
  const {digest}=await import('../dist/packages/core/delegation.js');
  const input=postgresHandoffOperationSchema.parse(JSON.parse(readOwnedBindingFile(values.input,65536,true).toString('utf8')));
  const preview=previewPostgresHandoff(input),previewDigest=digest(preview);
  if(!values.apply){console.log(JSON.stringify({...preview,previewDigest},null,2));}
  else{
    if(previewDigest!==values['expected-preview-digest'])throw new Error('Reviewed preview changed');
    if(existsSync(values.output))throw new Error('Receipt output already exists; inspect it instead of retrying');
    const binding=readPostgresBinding(input.binding.path).binding;
    const adminUser=process.env.EIGOS_POSTGRES_ADMIN_USER,adminPassword=process.env.EIGOS_POSTGRES_ADMIN_PASSWORD;
    if(!adminUser||adminUser!==input.adminIdentity.user||!adminPassword||adminPassword.includes('\0'))throw new Error('Existing administrator credentials must match the reviewed target identity');
    const connection={...supabaseProxyOptions(binding.connection.host,binding.connection.port,binding.connection.proxyUrl),...postgresConnectionOptions(binding,{...process.env,EIGOS_POSTGRES_PASSWORD:adminPassword}),user:adminUser};
    admin=new pg.Client(connection);adminErrors=observePostgresClient(admin);await admin.connect();adminErrors.check();
    let relayWrappingKey;
    if(input.phase==='activate'&&binding.relay){const {postgresMigrationWrappingKey}=await import('../dist/packages/deployment/postgres-node-migration.js');relayWrappingKey=await postgresMigrationWrappingKey(binding.relay.wrappingKey,process.env);}
    const result=input.phase==='prepare-schema'?await preparePostgresRuntimeSchema(admin,input):await activatePostgresPrimary(admin,input,{relayWrappingKey});
    adminErrors.check();applied=true;
    // A separately connected runtime login reads the actual installed rows.
    // It is opened only after the acknowledged administrative transaction.
    let runtimeVerification,schemaVerification;
    readback=new pg.Client(connection);readbackErrors=observePostgresClient(readback);await readback.connect();readbackErrors.check();
    schemaVerification=await verifyPreparedPostgresRuntimeSchema(readback,input);readbackErrors.check();
    if(input.phase==='prepare-schema'&&schemaVerification.schemaReceiptDigest!==result.schemaReceiptDigest)throw new Error('Independent post-commit schema receipt differs');
    if(input.phase==='activate'){
      runtime=new pg.Client({...supabaseProxyOptions(binding.connection.host,binding.connection.port,binding.connection.proxyUrl),...postgresConnectionOptions(binding,process.env)});
      runtimeErrors=observePostgresClient(runtime);await runtime.connect();runtimeErrors.check();
      runtimeVerification=await verifyPostgresHandoffRuntime(runtime,input);runtimeErrors.check();
    }
    // Never overwrite an existing receipt or print credentials/error objects.
    writeFileSync(values.output,JSON.stringify({version:1,previewDigest,...result,schemaVerification,...(runtimeVerification?{runtimeVerification}:{})},null,2)+'\n',{mode:0o600,flag:'wx'});
    console.log(JSON.stringify({status:result.status,receiptWritten:true,runtimeStarted:false}));
  }
}catch(error){
  const first=adminErrors?.annotate(error)??error,second=readbackErrors?.annotate(first)??first,annotated=runtimeErrors?.annotate(second)??second;
  const code=annotated&&typeof annotated==='object'&&'code'in annotated&&/^[A-Z0-9_]{1,32}$/.test(String(annotated.code))?String(annotated.code):'HANDOFF_REFUSED';
  console.error(`PostgreSQL handoff failed (${code}); ${applied?'an administrative commit was acknowledged':'commit outcome may be unknown'}. Inspect immutable target receipts before any manual retry. No runtime was started.`);process.exitCode=1;
}finally{
  for(const [client,observer] of [[runtime,runtimeErrors],[readback,readbackErrors],[admin,adminErrors]])if(client){try{await client.end();observer?.check();}catch{process.exitCode=1;console.error('PostgreSQL handoff connection shutdown failed; inspect target receipts.');}finally{observer?.close();}}
}
