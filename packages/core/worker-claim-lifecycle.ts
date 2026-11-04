import {AsyncLocalStorage} from 'node:async_hooks';
import type {WorkClaim} from './store.js';

type Identity=Readonly<{owner:string;taskId:string;token:string}>;
interface ReleaseScope {
  open:boolean;
  identity?:Identity;
  beforeRelease?:()=>Promise<void>;
  pending?:Promise<void>;
}
const context=new AsyncLocalStorage<{scope:ReleaseScope;notifying:boolean}>();

/** Host lifecycle notification only. Capturing these headers creates no
 * database authority, receipt, lease renewal or additional execution time. */
export async function withWorkerClaimRelease<T>(claim:WorkClaim,beforeRelease:()=>Promise<void>,action:()=>Promise<T>):Promise<T>{
  const owner=claim.owner,taskId=claim.job.id,token=claim.token;
  if([owner,taskId,token].some(value=>typeof value!=='string'||!value)||typeof beforeRelease!=='function'||typeof action!=='function')throw new Error('An explicit original Worker release scope is required');
  const scope:ReleaseScope={open:true,identity:Object.freeze({owner,taskId,token}),beforeRelease};
  return context.run({scope,notifying:false},async()=>{
    try{return await action();}
    finally{scope.open=false;scope.identity=undefined;scope.beforeRelease=undefined;scope.pending=undefined;}
  });
}

/** Stop/drain only the current matching Worker's heartbeat before its caller
 * writes a release receipt. The caller retains every database/fence check.
 * Absent/closed scopes and different headers never invoke another Worker. */
export async function notifyWorkerClaimRelease(owner:string,taskId:string,token:string):Promise<void>{
  const current=context.getStore(),scope=current?.scope,identity=scope?.identity;
  if(!scope?.open||!identity||identity.owner!==owner||identity.taskId!==taskId||identity.token!==token)return;
  if(current?.notifying)throw new Error('Worker release notification cannot await itself');
  scope.pending??=Promise.resolve().then(()=>context.run({scope,notifying:true},async()=>{
    if(!scope.open||!scope.beforeRelease)throw new Error('Worker release scope closed before notification');
    const beforeRelease=scope.beforeRelease;
    await beforeRelease();
    if(!scope.open)throw new Error('Worker release scope closed during notification');
  }));
  await scope.pending;
}
