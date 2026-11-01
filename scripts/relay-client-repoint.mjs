import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import pg from 'pg';

const usage='Usage: node scripts/relay-client-repoint.mjs --apply --source-stopped --config /private/cutover.json --credential /private/node.json --agent-id <id> [--state /private/node.sqlite]';
let values;
try { ({values}=parseArgs({options:{help:{type:'boolean'},apply:{type:'boolean'},'source-stopped':{type:'boolean'},config:{type:'string'},credential:{type:'string'},'agent-id':{type:'string'},state:{type:'string'}}})); }
catch {console.error(usage);process.exit(2);}
if(values.help){console.log(usage);process.exit(0);}
if(!values.apply||!values['source-stopped']||!values.config||!isAbsolute(values.config)||!values.credential||!isAbsolute(values.credential)||!/^agent_[A-Za-z0-9_-]{43}$/.test(values['agent-id']??'')||(values.state&&!isAbsolute(values.state))){console.error(usage);process.exit(2);}
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const configSchema=z.strictObject({oldUrl:z.url(),newUrl:z.url(),targetSchema:z.string().regex(/^eigos_relay_[a-z0-9_]{1,40}$/),expectedSourceDigest:hash,
  workerName:z.string().regex(/^[a-z0-9-]{1,63}$/),workersSubdomain:z.string().regex(/^[a-z0-9-]{1,63}$/),projectRef:z.string().regex(/^[a-z0-9]{20}$/),
  poolerHost:z.string().regex(/^[a-z0-9-]+\.pooler\.supabase\.com$/),runtimeRole:z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
  caCertificateId:z.uuid(),expectedCaSha256:hash,expectedScriptEtag:hash,expectedCompatibilityDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),expectedCompatibilityFlags:z.array(z.string().min(1).max(200)).max(100),wranglerPath:z.string().refine(isAbsolute),wranglerConfigPath:z.string().refine(isAbsolute),
  auth:z.strictObject({issuer:z.string().min(1),audience:z.string().min(1),jwksUrl:z.string().min(1),clientIds:z.string().min(1),tenantClaim:z.string().min(1).optional()})});
const source=process.env.EIGOS_RELAY_POSTGRES_URL,caPath=process.env.EIGOS_RELAY_POSTGRES_CA_FILE;
if(!source||!caPath||!isAbsolute(caPath)){console.error('Set EIGOS_RELAY_POSTGRES_URL and an absolute EIGOS_RELAY_POSTGRES_CA_FILE.');process.exit(2);}
let url;try{url=new URL(source);}catch{console.error('Invalid PostgreSQL connection URL.');process.exit(2);}
if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!url.username||!url.password||!url.pathname.slice(1)||url.search||url.hash){console.error('Connection URL must contain host, database and credentials and must not include options.');process.exit(2);}
let client;
try {
  const {readPrivateJson}=await import('../dist/packages/relay/files.js');
  const config=configSchema.parse(readPrivateJson(values.config,32768));
  const fd=openSync(caPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let ca;
  try{const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.mode&0o022||(process.getuid&&stat.uid!==process.getuid())||stat.size<1||stat.size>131072)throw new Error('Invalid CA file');const data=Buffer.alloc(stat.size+1);let offset=0;while(offset<data.length){const n=readSync(fd,data,offset,data.length-offset,null);if(!n)break;offset+=n;}const after=fstatSync(fd);if(offset!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw new Error('CA file changed');ca=data.subarray(0,offset).toString('utf8');}finally{closeSync(fd);}
  if(createHash('sha256').update(ca).digest('hex')!==config.expectedCaSha256||url.hostname!==config.poolerHost||(url.port&&url.port!=='5432')||!decodeURIComponent(url.username).endsWith('.'+config.projectRef))throw new Error('Database connection does not match the reviewed configuration');
  client=new pg.Client({host:url.hostname,port:5432,database:decodeURIComponent(url.pathname.slice(1)),user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),ssl:{ca,rejectUnauthorized:true},connectionTimeoutMillis:15000,query_timeout:20000});await client.connect();
  const {cloudflareRelayBindingVerifier}=await import('../dist/packages/relay/cloudflare-binding.js');
  const {repointRelayClient}=await import('../dist/packages/agent-transport/client.js');
  const verifyDestinationBinding=cloudflareRelayBindingVerifier({...config,caPem:ca,targetDatabase:client,configPath:config.wranglerConfigPath});
  const result=await repointRelayClient({oldUrl:config.oldUrl,newUrl:config.newUrl,credentialPath:values.credential,...(values.state?{statePath:values.state}:{}),agentId:values['agent-id'],targetSchema:config.targetSchema,expectedSourceDigest:config.expectedSourceDigest,targetDatabase:client,verifyDestinationBinding});
  console.log(JSON.stringify(result));
}catch(error){const code=error&&typeof error==='object'&&'code'in error&&/^[A-Z0-9_]{1,32}$/.test(String(error.code))?String(error.code):'REPOINT_FAILED';console.error(`Relay repoint failed (${code}). The node may require migration recovery; no secrets were printed.`);process.exitCode=1;}
finally{if(client)await client.end();}
