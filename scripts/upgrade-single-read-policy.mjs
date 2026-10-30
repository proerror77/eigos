import {DatabaseSync} from 'node:sqlite';
import {lstatSync} from 'node:fs';
import {isAbsolute,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {upgradeSingleReadPolicy} from '../dist/packages/security/single-read-upgrade.js';
import {readRuntimeAuthority,storedRuntimeAuthority,runtimeAuthorityMatches} from '../dist/packages/core/runtime-authority.js';
const {values}=parseArgs({options:{database:{type:'string'},'expected-digest':{type:'string'},'expected-revision':{type:'string'},apply:{type:'boolean',default:false}}});
if(!values.database||!isAbsolute(values.database)||!values['expected-digest']||!values['expected-revision'])throw new Error('Use an owned database and the exact reviewed policy digest/revision');
const stat=lstatSync(values.database);if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid()||stat.mode&0o077)throw new Error('Private owned regular database required');
const db=new DatabaseSync(values.database);try{
 const authority=process.env.EIGOS_AUTHORITY_FILE?readRuntimeAuthority(process.env.EIGOS_AUTHORITY_FILE):undefined;
 const installed=storedRuntimeAuthority(db);
 if(installed && (!authority || !runtimeAuthorityMatches(db,authority) || resolve(values.database)!==resolve(authority.databasePath)) || !installed && authority)throw new Error('Exact installed primary authority required');
 console.log(JSON.stringify(upgradeSingleReadPolicy(db,{digest:values['expected-digest'],revision:Number(values['expected-revision'])},values.apply)));
}finally{db.close();}
