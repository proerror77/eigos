import type {Client} from 'pg';
import type {OntologyModel} from '../ontology/model.js';
import {stagedKernelComponents,type StagedKernelBuilder} from '../ontology/seed-definition.js';
import {currentKernelImplementation} from '../ontology/definition-store.js';
import {persistentConsentPolicyContracts} from '../security/policy-store.js';
import {consentDeadline,consentExpiryIndex,type ConsentExpiry} from '../security/consent-lifetime.js';
import {SecurityError} from '../security/errors.js';
import {postgresBusinessSchema,postgresConstrainReadDeadline} from './runtime-transaction.js';

// Cache immutable contract computation, never grants, roles or eligibility.
const contracts=new WeakMap<OntologyModel,{modelDigest:string;after:string}>();
const preparedContracts=new Set<string>();
function persistentContract(model:OntologyModel):string{
  let contract=contracts.get(model);
  if(!contract||contract.modelDigest!==model.ref.digest){contract={modelDigest:model.ref.digest,after:persistentConsentPolicyContracts(model).after};contracts.set(model,contract);}
  return contract.after;
}
/** Called while constructing the host database, before its publisher starts.
 * The ready builder has the existing trusted 13-stage kernel brand. */
export function registerPostgresConsentKernel(builder:StagedKernelBuilder):void{
  preparedContracts.add(persistentContract(stagedKernelComponents(builder).model));
}
export function postgresConsentDeadline(expiresAt:ConsentExpiry,policyDigest:string,model?:OntologyModel):number{
  if(expiresAt===null){
    if(!model&&preparedContracts.has(policyDigest))return Infinity;
    const after=persistentContract(model??currentKernelImplementation());
    if(policyDigest!==after)throw new SecurityError('POLICY_CHANGED','Persistent consent requires the explicit policy upgrade');
  }
  return consentDeadline(expiresAt);
}

/** The finite SQL index is not a Worker lease or a user-facing expiry date. */
export function postgresConsentIndex(expiresAt:ConsentExpiry,policyDigest:string,model?:OntologyModel):number{
  postgresConsentDeadline(expiresAt,policyDigest,model);
  return consentExpiryIndex(expiresAt);
}

/** A consent without expiry contributes no fixed deadline. Existing current
 * manager, identity, claim and execution-window checks remain mandatory. */
export function postgresConstrainConsent(client:Client,expiresAt:ConsentExpiry,policyDigest:string,model?:OntologyModel):void{
  const until=postgresConsentDeadline(expiresAt,policyDigest,model);
  if(until!==Infinity)postgresConstrainReadDeadline(client,until);
}

/** Existing internal graph writers do not receive a policy argument. Resolve
 * its current row inside their exact transaction; never guess nullable mode. */
export async function postgresCurrentConsentDeadline(client:Client,expiresAt:ConsentExpiry,model?:OntologyModel):Promise<number>{
  if(expiresAt!==null)return consentDeadline(expiresAt);
  const rows=await client.query(`SELECT digest FROM "${postgresBusinessSchema(client)}".security_policy_definitions WHERE slot=1 LIMIT 2`);
  if(rows.rowCount!==1||typeof rows.rows[0]?.digest!=='string')throw new SecurityError('AUTHORITY_UNAVAILABLE');
  return postgresConsentDeadline(expiresAt,rows.rows[0].digest,model);
}
