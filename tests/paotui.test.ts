import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paotuiQuerySchema } from '../packages/capabilities/paotui-contracts.js';
import { readConfig } from '../packages/core/config.js';


test('personal Paotui cannot be enabled in JWT/public configuration', () => {
  assert.throws(() => readConfig({ EIGOS_PAOTUI_SKILL_DIR: '/tmp/skill', PUBLIC_URL: 'https://example.com', OAUTH_ISSUER: 'https://issuer.example', OAUTH_JWKS_URL: 'https://issuer.example/jwks', OAUTH_AUDIENCE: 'https://example.com' }), /restricted to local/);
});

test('fee previews require saved-address IDs and bounded goods; cannot carry order commands', () => {
  const query = { action: 'preview', senderAddressId: 'a', recipientAddressId: 'b', goodsName: '文件', category: '文件', weightKg: 1 };
  assert(paotuiQuerySchema.safeParse(query).success);
  for (const weightKg of [0, -1, 51]) assert(!paotuiQuerySchema.safeParse({ ...query, weightKg }).success);
  assert(!paotuiQuerySchema.safeParse({ ...query, command: 'submit_order' }).success);
  assert(!paotuiQuerySchema.safeParse({ ...query, senderAddressId: '' }).success);
});
