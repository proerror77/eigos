import type { TaskService } from './tasks.js';

type TaskOperation = 'describeOntology' | 'queryOntology' | 'evaluateOntology' | 'checkAccess'
  | 'usage' | 'submit' | 'get' | 'getAfterWait' | 'wait' | 'list' | 'reply' | 'amend' | 'resume'
  | 'authorize' | 'selectPaymentRoute' | 'reportPayment' | 'cancel' | 'reconcile'
  | 'revokeAuthorization' | 'requestRemediation';
type AwaitableOperation<F> = F extends (...args: infer A) => infer R
  ? (...args: A) => R | Promise<Awaited<R>> : never;

/** Protocol boundary for storage-backed operations. Discovery metadata is
 * synchronous; task operations may perform awaited authority/storage checks. */
export type TaskServicePort = Pick<TaskService, 'secured' | 'services'> & {
  [K in TaskOperation]: AwaitableOperation<TaskService[K]>;
};
