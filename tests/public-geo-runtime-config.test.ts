// Configuration parsing only: no .env files, login, credentials or provider reads.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readConfig, readWorkerConfig } from '../packages/core/config.js';

const query = { city: '北京市', keyword: '天安门' };
const development: NodeJS.ProcessEnv = {
  NODE_ENV: 'test', EIGOS_AUTH_MODE: 'development',
  EIGOS_DEV_TOKEN: 'synthetic-development-token-for-parser-tests-only',
};
const reader = '/tmp/eigos-public-geo-parser-fixture-not-executed';

for (const [role, read] of [['Gateway', readConfig], ['Worker', readWorkerConfig]] as const) {
  test(`${role} public discovery is off when configuration is omitted or an empty array`, () => {
    assert.equal(read(development).EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES, undefined);
    assert.deepEqual(read({ ...development, EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES: '[]' }).EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES, []);
    assert.equal(read({ ...development, EIGOS_PAOTUI_SKILL_DIR: reader }).EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES, undefined);
  });

  test(`${role} parses and normalizes bounded public query configuration`, () => {
    const queries = [query, { city: ' 上海市 ', keyword: ' 外滩 ' }];
    const config = read({ ...development, EIGOS_PAOTUI_SKILL_DIR: reader, EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES: JSON.stringify(queries) });
    assert.deepEqual(config.EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES, [query, { city: '上海市', keyword: '外滩' }]);
    const sixteen = Array.from({ length: 16 }, (_, index) => ({ city: '北京市', keyword: `Synthetic public place ${index}` }));
    assert.equal(read({ ...development, EIGOS_PAOTUI_SKILL_DIR: reader, EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES: JSON.stringify(sixteen) }).EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES?.length, 16);
    const maximumUnicode = Array.from({ length: 16 }, () => ({ city: '市'.repeat(50), keyword: '地'.repeat(100) }));
    const escaped = JSON.stringify(maximumUnicode).replace(/[市地]/g, value => '\\u' + value.charCodeAt(0).toString(16));
    assert(escaped.length <= 16384);
    assert.deepEqual(read({ ...development, EIGOS_PAOTUI_SKILL_DIR: reader, EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES: escaped }).EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES, maximumUnicode);
  });

  test(`${role} rejects malformed, oversized and nonpublic query configuration without echoing it`, () => {
    const privateMarker = 'PRIVATE_SYNTHETIC_CONFIG_MUST_NOT_BE_ECHOED';
    const invalid = [
      `${privateMarker}: not json`, '', 'null', '{}', JSON.stringify([null]), JSON.stringify(['not-a-query']),
      JSON.stringify([{ ...query, private: privateMarker }]),
      JSON.stringify([{ ...query, action: 'addresses' }]),
      JSON.stringify([{ city: query.city }]), JSON.stringify([{ ...query, keyword: '   ' }]),
      JSON.stringify([{ ...query, city: 123 }]), JSON.stringify([{ ...query, keyword: { privateMarker } }]),
      JSON.stringify([{ ...query, city: 'x'.repeat(51) }]), JSON.stringify([{ ...query, keyword: 'x'.repeat(101) }]),
      JSON.stringify(Array.from({ length: 17 }, (_, index) => ({ city: '北京市', keyword: `Synthetic public place ${index}` }))),
      ' '.repeat(16385),
    ];
    for (const value of invalid) assert.throws(
      () => read({ ...development, EIGOS_PAOTUI_SKILL_DIR: reader, EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES: value }),
      error => error instanceof Error && !error.message.includes(privateMarker),
    );
  });

  test(`${role} requires an existing reader configuration and nonproduction loopback development`, () => {
    const configured = { ...development, EIGOS_PAOTUI_SKILL_DIR: reader, EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES: JSON.stringify([query]) };
    assert.throws(() => read({ ...configured, EIGOS_PAOTUI_SKILL_DIR: undefined }));
    assert.throws(() => read({ ...configured, EIGOS_PAOTUI_SKILL_DIR: '' }));
    assert.throws(() => read({ ...configured, NODE_ENV: 'production' }));
    assert.throws(() => read({ ...configured, HOST: '0.0.0.0' }));
    assert.throws(() => read({ ...configured, PUBLIC_URL: 'http://example.test' }));
    const jwt: NodeJS.ProcessEnv = {
      NODE_ENV: 'test', EIGOS_AUTH_MODE: 'jwt', PUBLIC_URL: 'https://example.test',
      OAUTH_ISSUER: 'https://issuer.example.test', OAUTH_JWKS_URL: 'https://issuer.example.test/jwks', OAUTH_AUDIENCE: 'https://example.test',
    };
    assert.doesNotThrow(() => read(jwt));
    assert.doesNotThrow(() => read({ ...jwt, EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES: '[]' }));
    assert.throws(() => read({ ...jwt, EIGOS_PAOTUI_SKILL_DIR: reader, EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES: JSON.stringify([query]) }));
  });
}
