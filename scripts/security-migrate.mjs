import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {planSecurityMigration,migrateSecuritySnapshots,verifySecurityMigration} from '../dist/packages/security/migration.js';

// Explicit snapshots only. Never reads .env or rewrites a resident database.
try {
  const {positionals,values}=parseArgs({allowPositionals:true,options:{input:{type:'string'},output:{type:'string'},'expected-source-digest':{type:'string'}}});
  const [command]=positionals;if(positionals.length!==1)throw new Error('Choose plan, apply or verify');
  let result;
  if(command==='verify' && values.output)result=verifySecurityMigration(resolve(values.output));
  else {
    if(!values.input)throw new Error('An explicit private snapshot input JSON file is required');
    const raw=readFileSync(resolve(values.input));if(raw.length>64000)throw new Error('Input exceeds the limit');const input=JSON.parse(raw.toString('utf8'));
    if(command==='plan')result=planSecurityMigration(input);
    else if(command==='apply' && values.output && values['expected-source-digest'])result=migrateSecuritySnapshots({...input,outputDirectory:resolve(values.output),expectedSourceDigest:values['expected-source-digest']});
    else throw new Error('Apply requires output and expected-source-digest');
  }
  console.log(JSON.stringify(result));
}catch{console.error('Migration validation failed: check closed snapshots, expected digest, schema and unused destination. Source files were not changed.');process.exitCode=1;}
