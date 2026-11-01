import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync,constants,fstatSync,lstatSync,openSync,readSync,realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Client } from 'pg';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const uuid = z.uuid();
const deploymentSchema = z.object({ id:z.string().min(1),created_on:z.iso.datetime({offset:true}),versions:z.array(z.object({version_id:uuid,percentage:z.number()})) });
const bindingSchema = z.object({name:z.string(),type:z.string(),text:z.string().optional(),id:z.string().optional()});
const versionSchema = z.object({id:uuid,resources:z.object({bindings:z.array(bindingSchema),script:z.object({etag:z.string().regex(/^[a-f0-9]{64}$/)}),script_runtime:z.object({compatibility_date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),compatibility_flags:z.array(z.string()).optional()})})});
const hyperdriveSchema = z.object({id:z.string().regex(/^[a-f0-9]{32}$/),modified_on:z.iso.datetime({offset:true}),origin:z.object({host:z.string(),port:z.number(),database:z.string(),scheme:z.string(),user:z.string()}),caching:z.object({disabled:z.boolean()}),mtls:z.object({sslmode:z.string(),ca_certificate_id:z.string()})});
const hash = (text:string) => createHash('sha256').update(text).digest('hex');

type Destination = { origin:string; schema:string; sourceDigest:string; workerVersion:string|null };
type Readback = { deployments:unknown; version:unknown; hyperdrive:unknown; finalDeployments:unknown; finalHyperdrive:unknown };
export interface CloudflareRelayBindingOptions {
  workerName:string; workersSubdomain:string; projectRef:string; poolerHost:string; runtimeRole:string;
  caCertificateId:string; caPem:string; expectedCaSha256:string; expectedScriptEtag:string; expectedCompatibilityDate:string; expectedCompatibilityFlags:string[]; targetDatabase:Client;
  auth:{ issuer:string; audience:string; jwksUrl:string; clientIds:string; tenantClaim?:string };
}
function latest(input:unknown) {
  const values=z.array(deploymentSchema).min(1).parse(input).sort((a,b)=>Date.parse(b.created_on)-Date.parse(a.created_on));
  if (values.length>1 && values[0]!.created_on===values[1]!.created_on) throw new Error('Ambiguous Cloudflare deployment');
  const result=values[0]!;
  if(result.versions.length!==1 || result.versions[0]!.percentage!==100) throw new Error('Cloudflare deployment is not a single active version');
  return result;
}
/** Validate readback obtained directly from the trusted Cloudflare account. */
export function verifyCloudflareRelayReadback(options:CloudflareRelayBindingOptions, destination:Destination, data:Readback): boolean {
  try {
    if (!/^[a-z0-9-]{1,63}$/.test(options.workerName) || !/^[a-z0-9-]{1,63}$/.test(options.workersSubdomain)
      || !/^[a-z0-9]{20}$/.test(options.projectRef) || !/^[a-z0-9-]+\.pooler\.supabase\.com$/.test(options.poolerHost)
      || !/^[a-z_][a-z0-9_]{0,62}$/.test(options.runtimeRole) || !uuid.safeParse(options.caCertificateId).success
      || !/^eigos_relay_[a-z0-9_]{1,40}$/.test(destination.schema) || !/^[a-f0-9]{64}$/.test(destination.sourceDigest)
      || !/^[a-f0-9]{64}$/.test(options.expectedCaSha256) || hash(options.caPem)!==options.expectedCaSha256
      || !/^[a-f0-9]{64}$/.test(options.expectedScriptEtag) || !/^\d{4}-\d{2}-\d{2}$/.test(options.expectedCompatibilityDate) || !Array.isArray(options.expectedCompatibilityFlags) || !options.expectedCompatibilityFlags.includes('global_fetch_strictly_public') || new Set(options.expectedCompatibilityFlags).size!==options.expectedCompatibilityFlags.length || !uuid.safeParse(destination.workerVersion).success || destination.origin !== `https://${options.workerName}.${options.workersSubdomain}.workers.dev`) return false;
    const client=options.targetDatabase, ssl=(client as unknown as {ssl:unknown}).ssl;
    if(client.host!==options.poolerHost || client.port!==5432 || !client.database || !client.user?.endsWith('.'+options.projectRef)
      || client.getTransactionStatus()!=='I' || client.pipeline!==false || !ssl || typeof ssl!=='object') return false;
    const tls=ssl as {ca?:unknown;rejectUnauthorized?:unknown;servername?:unknown;checkServerIdentity?:unknown};
    if(typeof tls.ca!=='string' || !tls.ca || hash(tls.ca)!==hash(options.caPem) || tls.rejectUnauthorized!==true
      || (tls.servername!==undefined && tls.servername!==options.poolerHost) || tls.checkServerIdentity!==undefined) return false;
    const first=latest(data.deployments), last=latest(data.finalDeployments), version=versionSchema.parse(data.version), hyperdrive=hyperdriveSchema.parse(data.hyperdrive), finalHyperdrive=hyperdriveSchema.parse(data.finalHyperdrive);
    if(JSON.stringify(hyperdrive)!==JSON.stringify(finalHyperdrive))return false;
    if(first.id!==last.id || first.versions[0]!.version_id!==destination.workerVersion || last.versions[0]!.version_id!==destination.workerVersion || version.id!==destination.workerVersion || version.resources.script.etag!==options.expectedScriptEtag) return false;
    const flags=version.resources.script_runtime.compatibility_flags??[];
    if(version.resources.script_runtime.compatibility_date!==options.expectedCompatibilityDate || new Set(flags).size!==flags.length || JSON.stringify([...flags].sort())!==JSON.stringify([...options.expectedCompatibilityFlags].sort()))return false;
    const entries=version.resources.bindings;
    const one=(name:string)=>{const found=entries.filter(x=>x.name===name);if(found.length!==1)throw new Error('Missing or duplicate binding');return found[0]!;};
    const expected:Record<string,string>={RELAY_SCHEMA:destination.schema,EIGOS_RELAY_PUBLIC_URL:destination.origin,EIGOS_RELAY_OAUTH_ISSUER:options.auth.issuer,EIGOS_RELAY_OAUTH_AUDIENCE:options.auth.audience,EIGOS_RELAY_OAUTH_JWKS_URL:options.auth.jwksUrl,EIGOS_RELAY_CLIENT_IDS:options.auth.clientIds};
    for(const [name,value] of Object.entries(expected)){const b=one(name);if(b.type!=='plain_text'||b.text!==value)return false;}
    const tenant=entries.filter(x=>x.name==='EIGOS_RELAY_TENANT_CLAIM');
    if(tenant.length>1 || (tenant[0]?.text ?? 'tenant_id')!==(options.auth.tenantClaim ?? 'tenant_id') || (tenant[0] && tenant[0].type!=='plain_text'))return false;
    const meta=one('CF_VERSION_METADATA'), db=one('RELAY_DATABASE');
    if(meta.type!=='version_metadata' || db.type!=='hyperdrive' || !db.id || db.id!==hyperdrive.id) return false;
    return hyperdrive.origin.host===`db.${options.projectRef}.supabase.co` && hyperdrive.origin.port===5432
      && hyperdrive.origin.database===client.database && ['postgres','postgresql'].includes(hyperdrive.origin.scheme)
      && hyperdrive.origin.user===options.runtimeRole && hyperdrive.caching.disabled===true
      && hyperdrive.mtls.sslmode==='verify-full' && hyperdrive.mtls.ca_certificate_id===options.caCertificateId;
  } catch { return false; }
}

/** Read Cloudflare directly with an operator-owned Wrangler config; output and
 * child errors are kept private. The caller must still fence the old Relay. */
export function cloudflareRelayBindingVerifier(options:CloudflareRelayBindingOptions & {wranglerPath:string;configPath:string}) {
  const fixed = { ...options, auth:{...options.auth}, expectedCompatibilityFlags:[...options.expectedCompatibilityFlags] };
  if(resolve(fixed.wranglerPath)!==fixed.wranglerPath || resolve(fixed.configPath)!==fixed.configPath) throw new Error('Absolute Wrangler and config paths are required');
  const config=lstatSync(fixed.configPath);if(!config.isFile() || config.isSymbolicLink() || config.nlink!==1 || config.mode&0o022 || (process.getuid&&config.uid!==process.getuid()) || config.size>1024*1024) throw new Error('An owned non-writable Wrangler config is required');
  const readConfigHash=() => {
    const fd=openSync(fixed.configPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try { const stat=fstatSync(fd); if(!stat.isFile()||stat.dev!==config.dev||stat.ino!==config.ino||stat.nlink!==1||stat.mode&0o022||(process.getuid&&stat.uid!==process.getuid())||stat.size!==config.size||stat.mtimeMs!==config.mtimeMs||stat.ctimeMs!==config.ctimeMs) throw new Error('Wrangler config changed'); const bytes=Buffer.alloc(config.size+1);let offset=0;while(offset<bytes.length){const n=readSync(fd,bytes,offset,bytes.length-offset,null);if(!n)break;offset+=n;}const after=fstatSync(fd);if(offset!==config.size||after.size!==config.size||after.mtimeMs!==config.mtimeMs||after.ctimeMs!==config.ctimeMs)throw new Error('Wrangler config changed');return createHash('sha256').update(bytes.subarray(0,offset)).digest('hex'); }
    finally {closeSync(fd);}
  };
  const configHash=readConfigHash(),binary=realpathSync(fixed.wranglerPath);
  const names=['PATH','HOME','USER','SHELL','TMPDIR','LANG','LC_ALL','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY','SSL_CERT_FILE','NODE_EXTRA_CA_CERTS','CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_API_KEY','CLOUDFLARE_EMAIL','CF_API_TOKEN','CF_ACCOUNT_ID','XDG_CONFIG_HOME'];
  const env:NodeJS.ProcessEnv={};for(const name of names)if(process.env[name]!==undefined)env[name]=process.env[name];
  const run=async (args:string[],json=true) => {
    try {
      const {stdout}=await execFileAsync(binary,[...args,'--config',fixed.configPath,...(json?['--json']:[])],{env,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
      const start=json?0:stdout.indexOf('{');if(start<0)throw new Error('Invalid response');return JSON.parse(stdout.slice(start));
    } catch { throw new Error('Cloudflare readback unavailable'); }
  };
  return async (destination:Destination):Promise<boolean> => {
    const checked = { origin:destination.origin, schema:destination.schema, sourceDigest:destination.sourceDigest, workerVersion:destination.workerVersion };
    try {
      if(!/^[a-z0-9-]{1,63}$/.test(fixed.workerName) || !/^[a-z0-9-]{1,63}$/.test(fixed.workersSubdomain)
        || !/^eigos_relay_[a-z0-9_]{1,40}$/.test(checked.schema) || !/^[a-f0-9]{64}$/.test(checked.sourceDigest)
        || checked.origin!==`https://${fixed.workerName}.${fixed.workersSubdomain}.workers.dev`
        || !checked.workerVersion || !uuid.safeParse(checked.workerVersion).success || readConfigHash()!==configHash)return false;
      const deployments=await run(['deployments','list','--name',fixed.workerName]);
      const version=await run(['versions','view',checked.workerVersion,'--name',fixed.workerName]);
      const parsed=versionSchema.parse(version), db=parsed.resources.bindings.filter(b=>b.name==='RELAY_DATABASE');
      if(db.length!==1 || db[0]!.type!=='hyperdrive' || !db[0]!.id || !/^[a-f0-9]{32}$/.test(db[0]!.id))return false;
      const hyperdrive=await run(['hyperdrive','get',db[0]!.id],false);
      const finalDeployments=await run(['deployments','list','--name',fixed.workerName]);
      const finalHyperdrive=await run(['hyperdrive','get',db[0]!.id],false);
      return readConfigHash()===configHash && verifyCloudflareRelayReadback(fixed,checked,{deployments,version,hyperdrive,finalDeployments,finalHyperdrive});
    } catch { return false; }
  };
}
