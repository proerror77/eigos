import {test} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {OntologyModel} from '../packages/ontology/model.js';
import {roleAllows,roleSchema,legacyRoleSchema} from '../packages/security/resource-role.js';
import {legacySourceAuthorizationSchema,sourceAuthorizationSchema,legacyStoredSourceSchema,storedSourceSchema,sourceMatchesObservation} from '../packages/security/source-policy.js';
import {restrictionsFitRecipient,type RecipientClearance} from '../packages/security/field-restrictions.js';
import type {SecurityEnvelope} from '../packages/security/envelope.js';
import {SECURITY_CONTRACT,POLICY_VERSION} from '../packages/security/contracts.js';
import {consentDeadline} from '../packages/security/consent-lifetime.js';
import {currentKernelImplementation} from '../packages/ontology/definition-store.js';
import {persistentConsentPolicyContracts} from '../packages/security/policy-store.js';
import {postgresConsentDeadline,postgresConsentIndex,postgresConstrainConsent} from '../packages/postgres/consent.js';
import {SecurityError} from '../packages/security/errors.js';

test('PostgreSQL nullable consent requires the reviewed contract and never creates a lease or extends finite expiry',()=>{
  const model=currentKernelImplementation(),contracts=persistentConsentPolicyContracts(model);
  const policyChanged=(error:unknown)=>error instanceof SecurityError&&error.reason==='POLICY_CHANGED';
  assert.throws(()=>postgresConsentDeadline(null,contracts.before,model),policyChanged);
  assert.throws(()=>postgresConsentIndex(null,'0'.repeat(64),model),policyChanged);
  assert.equal(postgresConsentDeadline(null,contracts.after,model),Infinity);
  assert.equal(postgresConsentIndex(null,contracts.after,model),Number.MAX_SAFE_INTEGER);
  const expiresAt='2026-11-03T08:00:00.000Z';
  assert.equal(postgresConsentDeadline(expiresAt,contracts.before,model),Date.parse(expiresAt));
  assert.equal(postgresConsentDeadline(expiresAt,contracts.after,model),Date.parse(expiresAt));
  // No SQL, lease or synthetic future timestamp is produced for null consent.
  postgresConstrainConsent({} as never,null,contracts.after,model);
});

const now=Date.UTC(2026,10,3),clock=()=>now,future=new Date(now+60000).toISOString(),expired=new Date(now-1).toISOString(),member='11111111-1111-4111-8111-111111111111',installation='22222222-2222-4222-8222-222222222222';
const model=new OntologyModel({id:'consent.port.fixture',version:'1',objects:[{id:'Node',version:'1',name:'Node',aliases:[],description:'Synthetic pure consent fixture',primaryKey:'id',titleKey:'id',properties:{id:{kind:'string',schema:z.string().min(1),required:true,description:'Identity',source:'synthetic'}}}],interfaces:[],links:[],actions:[{id:'InspectNode',version:'1',description:'Synthetic definition only',inputs:{node:'Node'},changes:['Node'],submissionCriteria:['same_owner']}],functions:[{id:'readNode',version:'1',inputTypes:['Node'],description:'Synthetic function metadata'}]});
const role={subjectKind:'installation' as const,subjectId:installation,resource:{kind:'namespace' as const,id:model.ref.id,version:model.ref.digest},role:'Viewer' as const,executeActions:['InspectNode'],invokeFunctions:['readNode']};
const source={installationId:installation,bindingId:'original-source',programId:'synthetic.program',programDigest:'a'.repeat(64),operations:['InspectNode'],outputTypes:['Node']};
const stored={...source,parentGrant:{id:'33333333-3333-4333-8333-333333333333',revision:1},readbackVersions:[{sourceBindingId:'predecessor-source',programDigest:'b'.repeat(64)}]};
const envelope:SecurityEnvelope={version:SECURITY_CONTRACT,policyVersion:POLICY_VERSION,ownerKey:'synthetic-owner',classification:'sensitive',requiredMarkings:['member_private','personal_data'],channels:['registered_model'],lineage:[],lineageComplete:true};

test('current helper schemas require explicit nullable consent while legacy schemas preserve finite-only history',()=>{
  assert.equal(roleSchema.parse({...role,expiresAt:null}).expiresAt,null);assert.equal(sourceAuthorizationSchema.parse({...source,expiresAt:null}).expiresAt,null);assert.equal(storedSourceSchema.parse({...stored,expiresAt:null}).expiresAt,null);
  assert.throws(()=>legacyRoleSchema.parse({...role,expiresAt:null}));assert.throws(()=>legacySourceAuthorizationSchema.parse({...source,expiresAt:null}));assert.throws(()=>legacyStoredSourceSchema.parse({...stored,expiresAt:null}));
  assert.throws(()=>roleSchema.parse(role));assert.throws(()=>sourceAuthorizationSchema.parse(source));assert.throws(()=>storedSourceSchema.parse(stored));
  for(const expiresAt of [expired,future]){assert.equal(roleSchema.parse({...role,expiresAt}).expiresAt,expiresAt);assert.equal(legacyStoredSourceSchema.parse({...stored,expiresAt}).expiresAt,expiresAt);}
  assert.equal(consentDeadline(null),Infinity);assert.equal(consentDeadline(future),now+60000);
});

test('nullable roles retain exact subject, namespace, explicit action/function and finite deadline boundaries',()=>{
  const permanent=roleSchema.parse({...role,expiresAt:null}),finite=roleSchema.parse({...role,expiresAt:future}),past=roleSchema.parse({...role,expiresAt:expired});
  for(const current of [permanent,finite]){assert(roleAllows(model,[current],member,installation,'objectType','Node','resource.view',clock));assert(roleAllows(model,[current],member,installation,'actionType','InspectNode','action.execute',clock));assert(roleAllows(model,[current],member,installation,'function','readNode','function.invoke',clock));}
  const memberRole={...permanent,subjectKind:'member' as const,subjectId:member};assert(roleAllows(model,[memberRole],member,installation,'objectType','Node','resource.view',clock));assert(!roleAllows(model,[memberRole],installation,installation,'objectType','Node','resource.view',clock));
  assert(!roleAllows(model,[past],member,installation,'objectType','Node','resource.view',clock));assert(!roleAllows(model,[{...finite,expiresAt:new Date(now).toISOString()}],member,installation,'objectType','Node','resource.view',clock));
  assert(!roleAllows(model,[permanent],member,member,'objectType','Node','resource.view',clock));assert(!roleAllows(model,[{...permanent,resource:{...permanent.resource,version:'changed'}}],member,installation,'objectType','Node','resource.view',clock));
  assert(!roleAllows(model,[{...permanent,executeActions:[]}],member,installation,'actionType','InspectNode','action.execute',clock));assert(!roleAllows(model,[{...permanent,invokeFunctions:[]}],member,installation,'function','readNode','function.invoke',clock));
  assert(!roleAllows(model,[permanent],member,installation,'objectType','MissingType','resource.view',clock));
});

test('source observation matching keeps predecessor proof separate and checks expiry only with an explicit clock',()=>{
  const origin={programId:source.programId,programDigest:source.programDigest,sourceBindingId:source.bindingId};
  for(const expiresAt of [null,future]){const current=storedSourceSchema.parse({...stored,expiresAt});assert(sourceMatchesObservation([current],origin,'Node',clock));assert(sourceMatchesObservation([current],{...origin,sourceBindingId:'predecessor-source',programDigest:'b'.repeat(64)},'Node',clock));}
  const old=storedSourceSchema.parse({...stored,expiresAt:expired});assert(!sourceMatchesObservation([old],origin,'Node',clock));assert(sourceMatchesObservation([old],origin,'Node'),'historical matching omits a new wall-clock authority decision');
  const current=storedSourceSchema.parse({...stored,expiresAt:null});assert(!sourceMatchesObservation([current],{...origin,programId:'foreign.program'},'Node',clock));assert(!sourceMatchesObservation([current],{...origin,programDigest:'b'.repeat(64)},'Node',clock));assert(!sourceMatchesObservation([current],origin,'OtherType',clock));
  assert.deepEqual(current.operations,['InspectNode']);assert.equal(current.parentGrant.id,'33333333-3333-4333-8333-333333333333');assert.equal(current.expiresAt,null);
});

test('recipient consent never widens field markings, classification or agent-response/model channel boundaries',()=>{
  const clearance:RecipientClearance={classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response'],expiresAt:null};
  assert(restrictionsFitRecipient([envelope],clearance,false,clock));assert(!restrictionsFitRecipient([envelope],clearance,true,clock),'model-only input cannot be sent to the Agent');
  const output={...envelope,channels:['agent_response' as const]};assert(restrictionsFitRecipient([output],clearance,true,clock));
  assert(!restrictionsFitRecipient([{...output,classification:'internal'}],clearance,true,clock));
  assert(!restrictionsFitRecipient([output],{...clearance,markings:['member_private']},true,clock));assert(!restrictionsFitRecipient([output],{...clearance,classification:'private'},true,clock));assert(!restrictionsFitRecipient([output],{...clearance,channels:['registered_model']},true,clock));assert(!restrictionsFitRecipient([output],undefined,true,clock));
  assert(restrictionsFitRecipient([output],{...clearance,expiresAt:future},true,clock));assert(!restrictionsFitRecipient([output],{...clearance,expiresAt:expired},true,clock));assert(!restrictionsFitRecipient([output],{...clearance,expiresAt:new Date(now).toISOString()},true,clock));
  assert(restrictionsFitRecipient([output],{...clearance,expiresAt:expired},true),'callers retaining the legacy prefiltered contract control time separately');const {expiresAt:_expiry,...legacy}=clearance;assert(restrictionsFitRecipient([output],legacy,true,clock));
});
