import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runFunction } from '@eigos/function-test';

const binary = process.env.EIGOS_FUNCTION_HOST_BIN;
const componentPath = process.env.EIGOS_COMPONENT;
if (!binary || !componentPath) throw new Error('Set EIGOS_FUNCTION_HOST_BIN and EIGOS_COMPONENT');

test('the component sums values in the local function host', async () => {
  const result = await runFunction({ binary, component: await readFile(componentPath), input: { values: [2, 3] } });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.value, { sum: 5, count: 2 });
  assert.deepEqual(result.stagedEdits, []);
});
