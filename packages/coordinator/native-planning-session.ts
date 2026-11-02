import type { OntologyPlanningSession } from './planning-session.js';

/** The native transport may await a storage-backed session. Pure receipt and
 * budget state stays local; the session owns one serialized authorized RPC. */
export interface AsyncNativePlanningSession extends Pick<OntologyPlanningSession,
  'request'|'usesTaskContext'|'receipts'|'lastReceipt'|'readBudget'> {
  readonly asynchronous:true;
  readonly graph:{readonly security:true};
  catalog():Promise<ReturnType<OntologyPlanningSession['catalog']>>;
  call(...args:Parameters<OntologyPlanningSession['call']>):Promise<unknown>;
  acceptReceipts(ids:string[]):Promise<void>;
  authorizeModel(channel?:string):Promise<void>;
  runNativeRead<T>(action:()=>Promise<T>):Promise<T>;
}

export type NativePlanningSession=OntologyPlanningSession|AsyncNativePlanningSession;
export function isAsyncNativePlanningSession(session:NativePlanningSession):session is AsyncNativePlanningSession {
  return 'asynchronous'in session&&session.asynchronous===true;
}

/** Complete host reasoning contract. Storage-backed implementations release
 * their SQL transaction before model execution and await durable evidence. */
export interface AsyncPlanningSession extends AsyncNativePlanningSession {
  prepareContext(...args:Parameters<OntologyPlanningSession['prepareContext']>):Promise<ReturnType<OntologyPlanningSession['prepareContext']>>;
  modelSessionKey():ReturnType<OntologyPlanningSession['modelSessionKey']>;
}
export type ReasoningPlanningSession=OntologyPlanningSession|AsyncPlanningSession;
