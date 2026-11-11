import {parseArgs} from 'node:util';
import {isAbsolute} from 'node:path';
import {existsSync,writeFileSync} from 'node:fs';
import pg from 'pg';

const usage='Usage: node scripts/postgres-write-lock-upgrade.mjs --input /private/reviewed-handoff-operation.json [--apply --expected-preview-digest SHA256 --output /private/new-write-lock-receipt.json]\nPreview uses the existing pinned handoff/binding without credentials or network. Apply requires the same reviewed EIGOS_POSTGRES_ADMIN_USER/EIGOS_POSTGRES_ADMIN_PASSWORD and drained Worker claims/recoveries. It starts no runtime.';
let values;
try{({values}=parseArgs({options:{help:{type:'boolean'},input:{type:'string'},apply:{type:'boolean'},'expected-preview-digest':{type:'string'},output:{type:'string'}}}));}catch{console.error(usage);process.exit(2);}
if(values.help){console.log(usage);process.exit(0);}
if(!values.input||!isAbsolute(values.input)||values.apply&&(!/^[a-f0-9]{64}$/.test(values['expected-preview-digest']??'')||!values.output||!isAbsolute(values.output))||!values.apply&&(values.output||values['expected-preview-digest'])){console.error(usage);process.exit(2);}
let admin,readback,adminErrors,readbackErrors,attempted=false,acknowledged=false;
try{
  const {readOwnedBindingFile,postgresConnectionOptions,postgresBindingIdentity}=await import('../dist/packages/deployment/postgres-binding.js');
  const {readPostgresHandoffOperation}=await import('../dist/packages/deployment/postgres-handoff.js');
  const {upgradePostgresWriteLock}=await import('../dist/packages/postgres/write-lock-upgrade.js');
  const {postgresAuthorityWriteLockMode}=await import('../dist/packages/postgres/authority-lock.js');
  const {observePostgresClient}=await import('../dist/packages/postgres/client-errors.js');
  const {supabaseProxyOptions}=await import('../dist/packages/postgres/supabase-proxy.js');
  const {digest}=await import('../dist/packages/core/delegation.js');
  const checked=readPostgresHandoffOperation(JSON.parse(readOwnedBindingFile(values.input,65536,true).toString('utf8'))),{binding,operation}=checked;
  const preview={version:1,operation:'upgrade-postgres-write-lock',binding:postgresBindingIdentity(binding),adminIdentity:operation.adminIdentity,
    from:'FOR UPDATE',to:'FOR SHARE',requires:'drained original Worker claims and active recoveries',runtimeStarted:false};
  const previewDigest=digest(preview);
  if(!values.apply)console.log(JSON.stringify({...preview,previewDigest},null,2));
  else{
    if(previewDigest!==values['expected-preview-digest'])throw new Error('Reviewed preview changed');
    if(existsSync(values.output))throw new Error('Inspect the existing receipt rather than overwriting it');
    const user=process.env.EIGOS_POSTGRES_ADMIN_USER,password=process.env.EIGOS_POSTGRES_ADMIN_PASSWORD;
    if(!user||user!==operation.adminIdentity.user||!password||password.includes('\0'))throw new Error('Reviewed administrator credentials are required');
    const connection={...supabaseProxyOptions(binding.connection.host,binding.connection.port,binding.connection.proxyUrl),...postgresConnectionOptions(binding,{...process.env,EIGOS_POSTGRES_PASSWORD:password}),user};
    admin=new pg.Client(connection);adminErrors=observePostgresClient(admin);await admin.connect();
    const identity=(await admin.query('SELECT current_database() AS database,current_user AS role,session_user AS session_role')).rows[0];
    if(identity?.database!==binding.connection.database||identity.role!==operation.adminIdentity.role||identity.session_role!==operation.adminIdentity.role)throw new Error('Administrator target differs from the reviewed identity');
    attempted=true;
    const result=await upgradePostgresWriteLock(admin,binding.business.schema,binding.authority);adminErrors.check();acknowledged=true;
    readback=new pg.Client(connection);readbackErrors=observePostgresClient(readback);await readback.connect();
    if(await postgresAuthorityWriteLockMode(readback,binding.business.schema)!=='share')throw new Error('Independent write-lock readback failed');
    const current=(await readback.query(`SELECT id,revision,configuration_digest FROM "${binding.business.schema}".eigos_current_runtime_authority()`)).rows[0];
    if(current?.id!==binding.authority.id||String(current.revision)!==String(binding.authority.revision)||current.configuration_digest!==binding.authority.digest)throw new Error('Independent authority readback failed');
    readbackErrors.check();writeFileSync(values.output,JSON.stringify({...result,previewDigest,verifiedAt:new Date().toISOString(),runtimeStarted:false},null,2)+'\n',{mode:0o600,flag:'wx'});
    console.log(JSON.stringify({status:result.status,receiptWritten:true,runtimeStarted:false}));
  }
}catch{
  const message=acknowledged
    ? 'The write-lock transaction committed. Inspect the function and receipt before retrying.'
    : attempted
      ? 'The write-lock upgrade did not return a commit acknowledgement. Inspect the original function before retrying.'
      : 'The write-lock upgrade was refused before the transaction started. Check the reviewed input, target and credentials.';
  console.error(message);process.exitCode=1;
}finally{
  for(const [client,observer] of [[readback,readbackErrors],[admin,adminErrors]])if(client){try{await client.end();observer?.check();}catch{process.exitCode=1;}finally{observer?.close();}}
}
