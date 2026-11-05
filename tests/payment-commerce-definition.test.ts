import assert from 'node:assert/strict';
import {test} from 'node:test';
import {commerceReadDefinition,commerceReadModule} from '../packages/ontology/payment-commerce.js';
import {loadMcpReadModule,mcpReadModuleRef,parseBundledMcpReadModule} from '../packages/ontology/mcp-read.js';
import {createPaymentCommerceKernelDefinition} from '../packages/ontology/seed-definition.js';
import {compileOntologyDocument} from '../packages/ontology/model-compiler.js';
import {digest} from '../packages/core/delegation.js';

test('bundled payment definition retains the exact synchronous Node facade value and published module digest',()=>{
  const legacy=loadMcpReadModule(new URL('../packages/ontology/definitions/payment-commerce-readonly.json',import.meta.url));
  assert.deepEqual(commerceReadDefinition,legacy);
  assert.deepEqual(commerceReadModule,mcpReadModuleRef(legacy));
  assert.deepEqual(commerceReadModule,{id:'payment-commerce.readonly',version:'1',digest:'9e6f9c92834d58552bf839f5a29769df2c2da4c952dde70d971a143ba607896c'});
  assert(Object.isFrozen(commerceReadDefinition));assert(Object.isFrozen(commerceReadDefinition.actions));
});

test('bundled payment definitions still reject unknown schema properties and oversized encoded input',()=>{
  assert.throws(()=>parseBundledMcpReadModule({...structuredClone(commerceReadDefinition),unknownProperty:true}));
  assert.throws(()=>parseBundledMcpReadModule({...structuredClone(commerceReadDefinition),padding:'x'.repeat(128000)}),/size limit/);
});

test('static payment loading preserves the original v27 kernel document and model fingerprints',()=>{
  // Observed from the unchanged 5b79c44 implementation. These assertions catch
  // a loader change that silently changes the already published definition.
  const kernel=createPaymentCommerceKernelDefinition();
  assert.equal(digest(kernel.document),'e8d2a5b2912af497f962c559a5872a22679af40f771a0d7f002f05dc9c68d76c');
  assert.deepEqual(compileOntologyDocument(kernel.document,kernel.registry).ref,{id:'eigos.business',version:'27',digest:'8e5b11eb6b25d873b12f05d67232899f97af6af929b143397aa19e75379fc5e6'});
});
