import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readConfig} from '../packages/core/config.js';
import {actionDiscoverySchema} from '../packages/core/action-bindings.js';
import {validateVector} from '../packages/semantic/local-embedding.js';
import {createSemanticRuntime} from '../packages/semantic/runtime.js';

test('semantic configuration and input mode are explicit without changing default storage',()=>{
  const environment={PUBLIC_URL:'https://eigos.example',OAUTH_ISSUER:'https://issuer.example',OAUTH_JWKS_URL:'https://issuer.example/jwks',OAUTH_AUDIENCE:'https://audience.example/eigos'};
  assert.equal(readConfig(environment).EIGOS_SEMANTIC_MODEL_DIR,undefined);
  assert.throws(()=>readConfig({...environment,EIGOS_SEMANTIC_MODEL_DIR:'/absolute/model'}),/Semantic discovery requires PostgreSQL/);
  assert.equal(actionDiscoverySchema.parse({search:'车型价格',searchMode:'semantic'}).searchMode,'semantic');
  assert.throws(()=>actionDiscoverySchema.parse({searchMode:'implicit-execute'}));
});

test('local vector output must match dimensions, finiteness and normalization',()=>{
  const vector=Array.from({length:384},(_,i)=>i===0?1:0);
  assert.deepEqual(validateVector(vector),vector);
  assert.throws(()=>validateVector([1,0,0]),/384/);
  assert.throws(()=>validateVector(vector.map(()=>0)),/normalization/);
  assert.throws(()=>validateVector(vector.map(()=>NaN)),/finite/);
});

test('local serving requires an independent index reader before loading model artifacts',async()=>{
  await assert.rejects(()=>createSemanticRuntime({EIGOS_SEMANTIC_MODEL_DIR:'/missing/model'},{}),/independent index reader/);
  assert.equal(await createSemanticRuntime({},{}),undefined);
});
