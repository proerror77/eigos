import type { AgentProgram } from '../core/agent-program.js';
import type { ProviderBinding } from '../ontology/execution.js';
import type { RegisteredAdapter, DiscoverySource } from '../core/catalog.js';
import { bindingDigest } from '../core/catalog.js';
import { authorizationScope, withProjection,withIntegrity } from './context.js';
import { SecurityError } from './store.js';
import type {SecurityStore} from './store.js';
import {objectRefSchema,type ObjectRef} from '../ontology/model.js';
import type {Delivery} from '../core/catalog.js';

export function permittedCapability(id: string): boolean {
  const scope=authorizationScope(); if (!scope) return true;
  scope.assertCurrent();
  return scope.policies.security.agentGrant(scope.actor.installationId).capabilityIds.includes(id) && (!scope.grant || scope.grant.outputs.some(o=>o.programId===id));
}
export function secureProgram(program: AgentProgram,authority?:SecurityStore): AgentProgram {
  if(authority?.enabled && authorizationScope()?.policies.security!==authority) throw new SecurityError('AUTHORIZATION_REQUIRED');
  const scope=authorizationScope(); if (!scope) return program;
  if (!permittedCapability(program.ref.id)) throw new SecurityError('AUTHORIZATION_REQUIRED');
  const source=scope.policies.requireSource(scope,program.ref.id,program.configurationDigest);
  const origin={programId:program.ref.id,programDigest:program.configurationDigest,sourceBindingId:source.bindingId};
  const check=(action?:string)=>{
    scope.policies.requireSource(scope,program.ref.id,program.configurationDigest,action);
    if (action) {
      if (!program.actionIds.includes(action)) throw new SecurityError('AUTHORIZATION_REQUIRED');
      scope.policies.requireResource(scope,'actionType',action);
      scope.policies.requireResource(scope,'actionType',action,'action.execute');
    }
  };
  // Only registered semantic mappers receive a projection scope. Model tools
  // have no write method, cannot supply an origin, and cannot manufacture a binding.
  return new Proxy(program,{get(target,key){
    const value=Reflect.get(target,key,target);
    if(key==='guidance')return value+'\nFoundation field contract: query the currently described authorized fields. Source business facts are in observedData; private snapshot/data fields are unavailable. Use authorizedInput for a scope that declares it. PA-only response fields are never model inputs. A denied field cannot be recovered through an alternate query.';
    if (typeof value!=='function') return value;
    if (key==='initialize') return (...args:unknown[])=>{check();return withProjection(origin,()=>Reflect.apply(value,target,args));};
    if (key==='project') return (...args:unknown[])=>{check(String(args[1]));return withProjection(origin,()=>Reflect.apply(value,target,args));};
    if (key==='invoke' || key==='recover') return (...args:unknown[])=>{check(String(args[1]));return withIntegrity(()=>Reflect.apply(value,target,args));};
    if (key==='reconcilePAPayment') return (...args:unknown[])=>{check('reconcile_payment');return Reflect.apply(value,target,args);};
    if(key==='complete')return (...args:unknown[])=>scope.policies.readSnapshot(()=>withIntegrity(()=>{
      const delivery=Reflect.apply(value,target,args) as Delivery,refs=new Map<string,ObjectRef>();
      const collect=(input:unknown)=>{if(!input || typeof input!=='object')return;const ref=objectRefSchema.safeParse(input);if(ref.success){refs.set(JSON.stringify(ref.data),ref.data);return;}for(const value of Object.values(input))collect(value);};
      collect(args[1]);
      const collectComponentEvidence=(input:unknown)=>{if(!input || typeof input!=='object')return;for(const [key,value] of Object.entries(input))if(key==='securityEvidenceRefs')collect(value);else collectComponentEvidence(value);};
      collectComponentEvidence(delivery.artifact.data.result);
      if(refs.size>20)throw new SecurityError('OUTPUT_NOT_ALLOWED');
      delivery.artifact.data.result={...delivery.artifact.data.result,securityEvidenceRefs:[...refs.values()]};return delivery;
    }));
    if(['validate','validatePlanning','validatePause','authority','clarification','describeComponents'].includes(String(key))) return (...args:unknown[])=>scope.policies.readSnapshot(()=>withIntegrity(()=>Reflect.apply(value,target,args)));
    return value.bind(target);
  }});
}
export function secureAdapter(binding:ProviderBinding,adapter:RegisteredAdapter,authority?:SecurityStore):RegisteredAdapter {
  if(authority?.enabled && authorizationScope()?.policies.security!==authority) throw new SecurityError('AUTHORIZATION_REQUIRED');
  const scope=authorizationScope(); if (!scope) return adapter;
  const programId=binding.capabilityRef.id, programDigest=bindingDigest(binding);
  if (!permittedCapability(programId)) throw new SecurityError('AUTHORIZATION_REQUIRED');
  return new Proxy(adapter,{get(target,key){
    const value=Reflect.get(target,key,target);
    if (typeof value!=='function') return value;
    if (['prepare','execute','dispatch','observe','reconcile','resume'].includes(String(key))) return (...args:unknown[])=>{
      scope.policies.requireSource(scope,programId,programDigest,String(key));
      // Legacy provider operations need an explicit reviewed Ontology action
      // mapping before gaining execution permission in the new mode.
      if (['execute','dispatch','resume'].includes(String(key))) {
        const ctx=args[0] as {step?:{actionTypeRef?:{id:string}}};
        const action=ctx.step?.actionTypeRef?.id;
        if (!action) throw new SecurityError('AUTHORIZATION_REQUIRED');
        scope.policies.requireResource(scope,'actionType',action,'action.execute');
      }
      return Reflect.apply(value,target,args);
    };
    return value.bind(target);
  }});
}
export function secureDiscovery(source:DiscoverySource,programId:string,authority?:SecurityStore):DiscoverySource {
  if(authority?.enabled && authorizationScope()?.policies.security!==authority) throw new SecurityError('AUTHORIZATION_REQUIRED');
  const scope=authorizationScope(); if (!scope) return source;
  return new Proxy(source,{get(target,key){
    const value=Reflect.get(target,key,target);
    if (key==='discover') return (...args:unknown[])=>{
      if (!source.configurationDigest) throw new SecurityError('SOURCE_NOT_AUTHORIZED');
      scope.policies.requireSource(scope,programId,source.configurationDigest,'discover');
      return Reflect.apply(value,target,args);
    };
    return typeof value==='function'?value.bind(target):value;
  }});
}
