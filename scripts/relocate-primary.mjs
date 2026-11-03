import {readFileSync} from 'node:fs';
import {parseArgs} from 'node:util';
import {readRuntimeAuthority} from '../dist/packages/core/runtime-authority.js';
import {privateDeploymentFile} from '../dist/packages/deployment/preflight.js';
import {planPrimaryRelocation,relocatePrimarySnapshots} from '../dist/packages/deployment/relocation.js';

const {values}=parseArgs({options:{input:{type:'string'},apply:{type:'boolean'},'preserve-unpublished':{type:'boolean'},'expected-source-digest':{type:'string'}}});
if(!values.input)throw new Error('Provide --input with explicit closed business/membership snapshots, authorityFile and a new targetDirectory');
privateDeploymentFile(values.input);
const data=JSON.parse(readFileSync(values.input,'utf8'));
const keys=Object.keys(data).sort();
if(JSON.stringify(keys)!==JSON.stringify(['authorityFile','businessSnapshot','membershipSnapshot','targetDirectory']))throw new Error('Unexpected relocation input fields');
const input={businessSnapshot:data.businessSnapshot,membershipSnapshot:data.membershipSnapshot,targetDirectory:data.targetDirectory,sourceAuthority:readRuntimeAuthority(data.authorityFile),preserveUnpublished:values['preserve-unpublished']===true};
if(!values.apply)console.log(JSON.stringify(planPrimaryRelocation(input),null,2));
else{
  if(!/^[a-f0-9]{64}$/.test(values['expected-source-digest']??''))throw new Error('Apply requires the exact reviewed --expected-source-digest');
  console.log(JSON.stringify(relocatePrimarySnapshots(input,values['expected-source-digest']),null,2));
}
