import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { JobStore } from '../dist/packages/core/store.js';

// Local operator authority comes from access to the existing private database.
// This is not a network administration endpoint and never acquires source tokens.
const [command,inputFile]=process.argv.slice(2),path=process.env.DATABASE_PATH;
if(!path || path===':memory:' || !existsSync(resolve(path))) throw new Error('Use DATABASE_PATH for an existing foundation database');
const store=new JobStore(resolve(path),{securityMode:'foundation'});
try {
  const policy=store.security.policies;
  if(command==='status') console.log(JSON.stringify({securityVersion:2,policyRevision:policy.revision()}));
  else {
    if(!inputFile) throw new Error('Provide a reviewed JSON input file');
    const content=readFileSync(resolve(inputFile));
    if(content.length>256000)throw new Error('Input exceeds the administration bound');
    const input=JSON.parse(content.toString('utf8'));
    const {expectedRevision,...body}=input;
    if(!Number.isSafeInteger(expectedRevision) || expectedRevision<1) throw new Error('expectedRevision is required');
    let roleId;
    if(command==='grant-role') roleId=policy.setRole(body,expectedRevision).id;
    else if(command==='revoke-role') {if(Object.keys(body).join(',')!=='id') throw new Error('Expected only id');policy.revokeRole(body.id,expectedRevision);}
    else if(command==='recipient') {const {installationId,...clearance}=body;policy.setRecipient(installationId,clearance,expectedRevision);}
    else if(command==='model-channel') {const {id,...clearance}=body;policy.setModelChannel(id,clearance,expectedRevision);}
    else if(command==='restrict-object') policy.restrictObject(body,expectedRevision);
    else if(command==='review-definition') {
      const {candidateFile,...request}=body;const content=readFileSync(resolve(candidateFile));if(content.length>256000)throw new Error('Candidate exceeds the review bound');
      console.log(JSON.stringify(policy.reviewDefinition({...request,candidate:JSON.parse(content.toString('utf8'))},expectedRevision)));process.exitCode=0;
    }
    else throw new Error('Use status, grant-role, revoke-role, recipient, model-channel, restrict-object, or review-definition');
    if(command!=='review-definition')console.log(JSON.stringify({policyRevision:policy.revision(),applied:true,...(roleId?{roleId}:{})}));
  }
} finally {store.close();}
