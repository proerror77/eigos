import type {ActionIntent} from '../ontology/actions.js';
/** Cancellation preserves uncertain external effects for original-key audit. */
export function cancelTaskIntent(intent:ActionIntent,now:number):boolean{
  if(intent.state==='ready')intent.state='canceled_before_dispatch';
  else if(['read','local'].includes(intent.effect)&&['dispatching','awaiting_remote','effect_unknown'].includes(intent.state)){
    intent.state='canceled_after_dispatch';intent.needsObservation=false;return false;
  }
  if(intent.state==='dispatching')intent.state='effect_unknown';
  if(['effect_unknown','awaiting_remote'].includes(intent.state)){intent.nextAt=now;return true;}
  return false;
}
