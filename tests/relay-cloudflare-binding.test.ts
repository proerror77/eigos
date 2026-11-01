import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { verifyCloudflareRelayReadback, type CloudflareRelayBindingOptions } from '../packages/relay/cloudflare-binding.js';

test('Cloudflare Relay binding verification rejects wrong deployment, origin, database, TLS and auth', () => {
  const version=randomUUID(),caId=randomUUID(),hyperdriveId=randomBytes(16).toString('hex'),projectRef='abcdefghijklmnopqrst',workerName='eigos-relay-test',workersSubdomain='fixture',schema='eigos_relay_fixture',origin=`https://${workerName}.${workersSubdomain}.workers.dev`,etag='c'.repeat(64),poolerHost='aws-0-us-east-1.pooler.supabase.com';
  const targetDatabase={host:poolerHost,port:5432,database:'postgres',user:`postgres.${projectRef}`,pipeline:false,getTransactionStatus:()=> 'I',ssl:{ca:'fixture-ca',rejectUnauthorized:true}} as unknown as Client;
  const options:CloudflareRelayBindingOptions={workerName,workersSubdomain,projectRef,poolerHost,runtimeRole:'relay_runtime',caCertificateId:caId,caPem:'fixture-ca',expectedCaSha256:createHash('sha256').update('fixture-ca').digest('hex'),expectedScriptEtag:etag,expectedCompatibilityDate:'2026-10-02',expectedCompatibilityFlags:[] as string[],targetDatabase,auth:{issuer:'https://issuer.example',audience:origin,jwksUrl:'https://issuer.example/jwks',clientIds:'fixture-client'}};
  const destination={origin,schema,sourceDigest:'d'.repeat(64),workerVersion:version};
  const latest={id:'deployment',created_on:'2026-11-01T12:00:00Z',versions:[{version_id:version,percentage:100}]};
  const bindings=[['RELAY_SCHEMA',schema],['EIGOS_RELAY_PUBLIC_URL',origin],['EIGOS_RELAY_OAUTH_ISSUER',options.auth.issuer],['EIGOS_RELAY_OAUTH_AUDIENCE',origin],['EIGOS_RELAY_OAUTH_JWKS_URL',options.auth.jwksUrl],['EIGOS_RELAY_CLIENT_IDS',options.auth.clientIds]].map(([name,text])=>({name,type:'plain_text',text}));
  const versionData={id:version,resources:{script:{etag},script_runtime:{compatibility_date:'2026-10-02'},bindings:[...bindings,{name:'CF_VERSION_METADATA',type:'version_metadata'},{name:'RELAY_DATABASE',type:'hyperdrive',id:hyperdriveId}]}};
  const hyperdrive={id:hyperdriveId,modified_on:'2026-11-01T12:00:00Z',origin:{host:`db.${projectRef}.supabase.co`,port:5432,database:'postgres',scheme:'postgresql',user:'relay_runtime'},caching:{disabled:true},mtls:{sslmode:'verify-full',ca_certificate_id:caId}};
  const data={deployments:[latest],version:versionData,hyperdrive,finalDeployments:[latest],finalHyperdrive:hyperdrive};
  assert.equal(verifyCloudflareRelayReadback(options,destination,data),true);
  const deny=(changed:unknown)=>assert.equal(verifyCloudflareRelayReadback(options,destination,changed as typeof data),false);
  deny({...data,finalDeployments:[{...latest,id:'other'}]});
  deny({...data,deployments:[{...latest,versions:[{version_id:version,percentage:50},{version_id:randomUUID(),percentage:50}]}]});
  deny({...data,version:{...versionData,resources:{...versionData.resources,script:{etag:'e'.repeat(64)}}}});
  deny({...data,version:{...versionData,resources:{...versionData.resources,script_runtime:{compatibility_date:'2026-10-03'}}}});
  deny({...data,version:{...versionData,resources:{...versionData.resources,script_runtime:{compatibility_date:'2026-10-02',compatibility_flags:['unreviewed']}}}});
  deny({...data,version:{...versionData,resources:{...versionData.resources,bindings:[...versionData.resources.bindings,{name:'RELAY_SCHEMA',type:'plain_text',text:schema}]}}});
  deny({...data,hyperdrive:{...hyperdrive,origin:{...hyperdrive.origin,host:'db.other.supabase.co'}}});
  deny({...data,hyperdrive:{...hyperdrive,caching:{disabled:false}}});
  deny({...data,finalHyperdrive:{...hyperdrive,modified_on:'2026-11-01T12:01:00Z'}});
  deny({...data,hyperdrive:{...hyperdrive,mtls:{...hyperdrive.mtls,sslmode:'require'}}});
  deny({...data,hyperdrive:{...hyperdrive,mtls:{...hyperdrive.mtls,ca_certificate_id:randomUUID()}}});
  deny({...data,version:{...versionData,resources:{...versionData.resources,bindings:versionData.resources.bindings.filter(b=>b.name!=='CF_VERSION_METADATA')}}});
  assert.equal(verifyCloudflareRelayReadback(options,{...destination,workerVersion:randomUUID()},data),false);
  assert.equal(verifyCloudflareRelayReadback({...options,workersSubdomain:'other'},destination,data),false);
  assert.equal(verifyCloudflareRelayReadback({...options,auth:{...options.auth,audience:'wrong'}},destination,data),false);
  assert.equal(verifyCloudflareRelayReadback({...options,caPem:'wrong'},destination,data),false);
  assert.equal(verifyCloudflareRelayReadback({...options,targetDatabase:{...targetDatabase,ssl:{ca:'fixture-ca',rejectUnauthorized:false}} as unknown as Client},destination,data),false);
  assert.equal(verifyCloudflareRelayReadback({...options,targetDatabase:{...targetDatabase,ssl:{ca:'fixture-ca',rejectUnauthorized:true,servername:'wrong.example'}} as unknown as Client},destination,data),false);
  assert.equal(verifyCloudflareRelayReadback({...options,targetDatabase:{...targetDatabase,ssl:{ca:'fixture-ca',rejectUnauthorized:true,checkServerIdentity:()=>undefined}} as unknown as Client},destination,data),false);
});

test('Wrangler binding verifier reads trusted output without forwarding database secrets and rejects config changes', async () => {
  const { mkdtempSync,readFileSync,writeFileSync,rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { cloudflareRelayBindingVerifier } = await import('../packages/relay/cloudflare-binding.js');
  const dir=mkdtempSync(join(tmpdir(),'eigos-cf-binding-')), configPath=join(dir,'wrangler.json'), runner=join(dir,'wrangler'), dataPath=join(dir,'response.json'), logPath=join(dir,'calls.log');
  const version=randomUUID(),caId=randomUUID(),hyperdriveId=randomBytes(16).toString('hex'),projectRef='abcdefghijklmnopqrst',workerName='eigos-relay-test',workersSubdomain='fixture',schema='eigos_relay_fixture',origin=`https://${workerName}.${workersSubdomain}.workers.dev`,etag='c'.repeat(64),poolerHost='aws-0-us-east-1.pooler.supabase.com';
  const targetDatabase={host:poolerHost,port:5432,database:'postgres',user:`postgres.${projectRef}`,pipeline:false,getTransactionStatus:()=> 'I',ssl:{ca:'fixture-ca',rejectUnauthorized:true}} as unknown as Client;
  const options={workerName,workersSubdomain,projectRef,poolerHost,runtimeRole:'relay_runtime',caCertificateId:caId,caPem:'fixture-ca',expectedCaSha256:createHash('sha256').update('fixture-ca').digest('hex'),expectedScriptEtag:etag,expectedCompatibilityDate:'2026-10-02',expectedCompatibilityFlags:[] as string[],targetDatabase,auth:{issuer:'https://issuer.example',audience:origin,jwksUrl:'https://issuer.example/jwks',clientIds:'fixture-client'},wranglerPath:runner,configPath};
  const bindings=[['RELAY_SCHEMA',schema],['EIGOS_RELAY_PUBLIC_URL',origin],['EIGOS_RELAY_OAUTH_ISSUER',options.auth.issuer],['EIGOS_RELAY_OAUTH_AUDIENCE',origin],['EIGOS_RELAY_OAUTH_JWKS_URL',options.auth.jwksUrl],['EIGOS_RELAY_CLIENT_IDS',options.auth.clientIds]].map(([name,text])=>({name,type:'plain_text',text}));
  const record={deployments:[{id:'deployment',created_on:'2026-11-01T12:00:00Z',versions:[{version_id:version,percentage:100}]}],version:{id:version,resources:{script:{etag},script_runtime:{compatibility_date:'2026-10-02'},bindings:[...bindings,{name:'CF_VERSION_METADATA',type:'version_metadata'},{name:'RELAY_DATABASE',type:'hyperdrive',id:hyperdriveId}]}},hyperdrive:{id:hyperdriveId,modified_on:'2026-11-01T12:00:00Z',origin:{host:`db.${projectRef}.supabase.co`,port:5432,database:'postgres',scheme:'postgresql',user:'relay_runtime'},caching:{disabled:true},mtls:{sslmode:'verify-full',ca_certificate_id:caId}}};
  writeFileSync(configPath,'{}',{mode:0o600});writeFileSync(dataPath,JSON.stringify(record),{mode:0o600});
  writeFileSync(runner,`#!/usr/bin/env node\nconst fs=require('node:fs');if(process.env.PGPASSWORD||process.env.EIGOS_RELAY_POSTGRES_URL)process.exit(42);const d=JSON.parse(fs.readFileSync(${JSON.stringify(dataPath)},'utf8'));const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(logPath)},a[0]+'\\n',{mode:0o600});process.stdout.write(JSON.stringify(a[0]==='deployments'?d.deployments:a[0]==='versions'?d.version:d.hyperdrive));\n`,{mode:0o700});
  const previousPassword=process.env.PGPASSWORD,previousUrl=process.env.EIGOS_RELAY_POSTGRES_URL;
  try {
    process.env.PGPASSWORD='synthetic-secret';process.env.EIGOS_RELAY_POSTGRES_URL='synthetic-secret';
    const verify=cloudflareRelayBindingVerifier(options),destination={origin,schema,sourceDigest:'d'.repeat(64),workerVersion:version};
    const checking=verify(destination);destination.workerVersion=randomUUID();assert.equal(await checking,true);destination.workerVersion=version;
    options.expectedScriptEtag='e'.repeat(64);options.auth.issuer='https://changed.example';options.expectedCompatibilityFlags.push('changed');
    assert.equal(await verify(destination),true);
    const beforeMissing=readFileSync(logPath,'utf8');assert.equal(await verify({...destination,workerVersion:null}),false);assert.equal(readFileSync(logPath,'utf8'),beforeMissing);
    const priorCalls=readFileSync(logPath,'utf8').split('\n').filter(x=>x==='hyperdrive').length;
    const index=record.version.resources.bindings.findIndex(x=>x.name==='RELAY_DATABASE');assert(index>=0);record.version.resources.bindings[index]={name:'RELAY_DATABASE',type:'hyperdrive',id:'--help'};writeFileSync(dataPath,JSON.stringify(record));
    assert.equal(await verify(destination),false);
    assert.equal(readFileSync(logPath,'utf8').split('\n').filter(x=>x==='hyperdrive').length,priorCalls);
    writeFileSync(configPath,'{ }');assert.equal(await verify(destination),false);
  } finally {
    if(previousPassword===undefined)delete process.env.PGPASSWORD;else process.env.PGPASSWORD=previousPassword;
    if(previousUrl===undefined)delete process.env.EIGOS_RELAY_POSTGRES_URL;else process.env.EIGOS_RELAY_POSTGRES_URL=previousUrl;
    rmSync(dir,{recursive:true,force:true});
  }
});
