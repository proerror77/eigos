import { parentPort, workerData } from 'node:worker_threads';
import { getQuickJS, type QuickJSDeferredPromise } from 'quickjs-emscripten';

const port = parentPort!;
const { code, writable } = workerData as { code: string; writable: boolean };
const runtime = (await getQuickJS()).newRuntime();
const deadline = Date.now() + 7_500;
runtime.setInterruptHandler(() => Date.now() >= deadline);
runtime.setMemoryLimit(16 * 1024 * 1024);
runtime.setMaxStackSize(512 * 1024);
const vm = runtime.newContext();
let sequence = 0;
const pending = new Map<number, QuickJSDeferredPromise>();

try {
  vm.newFunction('sendRequest', (operation, input) => {
    const id = ++sequence, promise = vm.newPromise();
    pending.set(id, promise);
    port.postMessage({ kind: 'request', operation: vm.getString(operation), id, input: vm.getString(input) });
    return promise.handle;
  }).consume(handle => vm.setProp(vm.global, 'sendRequest', handle));
  port.on('message', ({ id, value }: { id: number; value: string }) => {
    const promise = pending.get(id);
    if (!promise) return;
    pending.delete(id);
    vm.newString(value).consume(handle => promise.resolve(handle));
    runtime.executePendingJobs().error?.dispose();
  });

  const result = vm.unwrapResult(vm.evalCode(`(async () => {
    const call = async (name, input) => JSON.parse(await sendRequest(name, JSON.stringify(input)));
    const query = input => call('query', input);
    const api = ${writable ? "{ query, applyAction: input => call('action', input) }" : "{ query }"};
    const program = (${code}
    );
    return JSON.stringify(await program(Object.freeze(api)));
  })()`, 'ontology-query.js'));
  try {
    const completion = vm.resolvePromise(result);
    runtime.executePendingJobs().error?.dispose();
    const value = vm.unwrapResult(await completion);
    try {
      if (vm.typeof(value) !== 'string') throw new Error('Return a JSON value');
      port.postMessage({ kind: 'result', value: vm.getString(value) });
    } finally { value.dispose(); }
  } finally { result.dispose(); }
} catch (error) {
  const message = error instanceof Error ? error.message : 'The program failed';
  port.postMessage({ kind: 'invalid', message: message.slice(0, 240) });
} finally {
  port.close();
  for (const promise of pending.values()) promise.dispose();
  vm.dispose();
  runtime.dispose();
}
