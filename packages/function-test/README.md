# Offline EIGOS Function tests

Run `npm run build:function-test` from the EIGOS repository and create a local tarball with
`npm pack ./dist/function-test-package --pack-destination /tmp`.
Install the resulting tarball in a Function project with
`npm install --offline --no-audit --no-fund /tmp/eigos-function-test-0.1.0.tgz`.
The package has no runtime dependencies.

`runFunction` starts a local protocol 2 function host, uploads the component and
invokes it with JSON input. Use a host binary for your operating system and
architecture. The harness requires Node.js and the host binary. It uses a
temporary component cache and a loopback callback.

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runFunction } from '@eigos/function-test';

const outcome = await runFunction({
  binary: process.env.EIGOS_FUNCTION_HOST_BIN,
  component: await readFile('function.wasm'),
  input: { values: [2, 3] },
});
assert.deepEqual(outcome.value, { sum: 5, count: 2 });
```

Pass `objects` with `ref`, `revision` and `properties` for get callbacks.
Supply `stubs` for follow, query, evaluate or aggregate and override get as
needed. A stub receives the callback arguments and a context with the
fixture principal, get helper and edits so far. These fixtures express test
expectations. Published Ontology permissions and query semantics are exercised
by runtime integration tests.

With `allowEdits: true`, object edits update the per-call fixture so later gets
see them. Link and unlink edits appear in `stagedEdits`, which a follow stub can
use to compute its answer. On a component failure, `stagedEdits` describes the
attempted writes. Every invocation starts from the supplied fixture.

Protocol 4 tests may supply deterministic model segments for a component using `eigos:models/language-model`. Set `models: { Writer: (messages, principal) => ['one', 'two'] }` and `streaming: true`. The returned `chunks` array contains the guest’s emitted text in order. The fixture does not need a model endpoint or credential.

The test implementation is supplied by the pinned Foundry SDK. The EIGOS package preserves the template import path.
