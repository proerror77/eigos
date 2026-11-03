import {AsyncLocalStorage} from 'node:async_hooks';

export interface ModelDispatchGuard {
  readonly channelId:string;
  /** Host-owned current authority/evidence check, immediately before model
   * dispatch. It runs outside the business transaction and grants no renewal. */
  authorize():Promise<void>;
}
const guards=new AsyncLocalStorage<readonly ModelDispatchGuard[]>();

/** Nested execution may narrow the outer boundary, never replace it. This
 * context carries no database, model credential or request-provided callback. */
export function withModelDispatchGuard<T>(guard:ModelDispatchGuard,run:()=>T):T {
  if(!guard.channelId||guard.channelId.length>200||typeof guard.authorize!=='function')throw new Error('Explicit model dispatch guard is required');
  const captured=Object.freeze({channelId:guard.channelId,authorize:guard.authorize.bind(guard)});
  return guards.run(Object.freeze([...(guards.getStore()??[]),captured]),run);
}

/** Called after local CLI preparation, before the prompt enters the process. */
export async function authorizeModelDispatch(channelId:string):Promise<void> {
  for(const guard of guards.getStore()??[]){
    if(guard.channelId!==channelId)throw new Error('Model dispatch channel differs from its admitted boundary');
    await guard.authorize();
  }
}
