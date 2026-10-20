import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paotuiAccountResponse } from '../packages/capabilities/paotui-account-response.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalPaotuiReader } from '../packages/capabilities/paotui.js';

test('provider account proof requires successful authenticated owned-address data with one explicit account', () => {
  const response = (rows: unknown[], code = 0) => ({ code: 0, data: JSON.stringify({ code, data: { userAddresses: rows } }) });
  assert.deepEqual(paotuiAccountResponse(response([{ id: 1, userId: 123 }, { id: 2, userId: 123 }])), { accountId: '123', addressIds: ['1', '2'] });
  for (const bad of [response([]), response([{ id: 1 }]), response([{ id: 1, userId: 123 }, { id: 2, userId: 456 }]), response([{ id: 1, userId: 123 }, { id: 1, userId: 123 }]), response([{ id: 1, userId: 0 }]), response([{ id: 1, userId: Number.MAX_SAFE_INTEGER + 1 }]), response([{ id: 1, userId: 123 }], 401), { code: 401, data: '{}' }, { accountId: '123' }]) assert.equal(paotuiAccountResponse(bad), undefined);
});

test('CLI stdout claims and a proof for another book cannot establish an account identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-account-fixture-'));
  try {
    for (const mismatchedProof of [false, true]) {
      writeFileSync(join(dir, 'paotui.js'), `const fs=require('node:fs');if(${mismatchedProof})fs.writeFileSync(process.env.EIGOS_SOURCE_ACCOUNT_RESULT,JSON.stringify({accountId:'123',addressIds:['different-book']}));console.log(JSON.stringify({status:'ok',accountIdentity:'${'a'.repeat(64)}',addresses:[{addressId:'one',address:'Synthetic',cityId:1,lat:1,lng:1}]}));`);
      let identities = 0;
      const reader = new LocalPaotuiReader(dir, undefined, undefined, () => 'FIXTURE_CREDENTIAL_ONLY', () => { identities++; return 'b'.repeat(64); });
      const book = await reader.atomic('get_address_list', {}, AbortSignal.timeout(10000));
      assert.equal(book.accountIdentity, undefined); assert.equal(identities, 0);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
