import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';

const usage='Usage: node scripts/business-postgres-verify.mjs --snapshot /private/business.sqlite --authority /private/authority.json --policy-digest <reviewed-digest> --expected-file-digest <reviewed-digest> --schema eigos_business_NAME';
let values;
try {({values}=parseArgs({options:{help:{type:'boolean'},snapshot:{type:'string'},authority:{type:'string'},'policy-digest':{type:'string'},'expected-file-digest':{type:'string'},schema:{type:'string'}}}));}
catch {console.error(usage);process.exit(2);}
if(values.help){console.log(usage);process.exit(0);}
if(!values.snapshot || !isAbsolute(values.snapshot) || !values.authority || !isAbsolute(values.authority) || !/^[a-f0-9]{64}$/.test(values['policy-digest']??'') || !/^[a-f0-9]{64}$/.test(values['expected-file-digest']??'') || !/^eigos_business_[a-z0-9_]{1,40}$/.test(values.schema??'')){console.error(usage);process.exit(2);}
const source=process.env.EIGOS_BUSINESS_POSTGRES_URL,caPath=process.env.EIGOS_BUSINESS_POSTGRES_CA_FILE;
if(!source || !caPath || !isAbsolute(caPath)){console.error('Set EIGOS_BUSINESS_POSTGRES_URL and an absolute EIGOS_BUSINESS_POSTGRES_CA_FILE.');process.exit(2);}
let url;
try {url=new URL(source);}catch {console.error('Invalid PostgreSQL connection URL.');process.exit(2);}
if(!['postgres:','postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || !url.pathname.slice(1) || url.search || url.hash){console.error('Connection URL must contain host, database and credentials and must not include options.');process.exit(2);}
let client;
try {
  const {readRuntimeAuthority,runtimeAuthorityDigest}=await import('../dist/packages/core/runtime-authority.js');
  const {verifyBusinessSnapshot}=await import('../dist/packages/postgres/business-verify.js');
  const authority=readRuntimeAuthority(values.authority);
  client=new pg.Client({host:url.hostname.replace(/^\[|\]$/g,''),port:url.port?Number(url.port):5432,database:decodeURIComponent(url.pathname.slice(1)),user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),ssl:{ca:readFileSync(caPath,'utf8'),rejectUnauthorized:true},connectionTimeoutMillis:15000});
  await client.connect();
  const result=await verifyBusinessSnapshot(client,{snapshot:values.snapshot,schema:values.schema,expectedFileDigest:values['expected-file-digest'],expectedAuthorityDigest:runtimeAuthorityDigest(authority),expectedPolicyDigest:values['policy-digest']});
  console.log(JSON.stringify(result,null,2));
} catch(error) {
  const code=error && typeof error==='object' && 'code' in error && /^[A-Z0-9_]{1,32}$/.test(String(error.code))?String(error.code):'VERIFICATION_FAILED';
  console.error(`Business verification failed (${code}). No runtime was activated.`);process.exitCode=1;
} finally {if(client)await client.end();}
