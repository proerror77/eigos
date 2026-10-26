import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { planConsolidation, consolidateSnapshots } from '../dist/packages/core/consolidation.js';
import { readRuntimeAuthority } from '../dist/packages/core/runtime-authority.js';

const {values}=parseArgs({options:{input:{type:'string'},output:{type:'string'},authority:{type:'string'},'expected-source-digest':{type:'string'},apply:{type:'boolean'}}});
if(!values.input)throw new Error('Provide --input containing explicit closed source snapshots and the reviewed policy digest');
const input=JSON.parse(readFileSync(values.input,'utf8'));
if(!values.apply)console.log(JSON.stringify(planConsolidation(input),null,2));
else {
  if(!values.output || !values.authority || !values['expected-source-digest'])throw new Error('Apply requires a new --output, owned --authority file and --expected-source-digest from the reviewed plan');
  console.log(JSON.stringify(consolidateSnapshots({...input,outputDirectory:values.output,authority:readRuntimeAuthority(values.authority),expectedSourceDigest:values['expected-source-digest']}),null,2));
}
