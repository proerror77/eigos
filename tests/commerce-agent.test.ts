import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setupCommerce, commerceReads, commerceDecision, commerceStep, commerceChoice } from './fixtures/commerce-agent.js';
import { owner, principal } from './backend-fixture.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { CommerceAgentProgram } from '../packages/capabilities/commerce-agent.js';
import { readConfig, readWorkerConfig } from '../packages/core/config.js';
import { digest } from '../packages/core/delegation.js';
import { assessLandedCost, checkedCommerceObservation } from '../packages/ontology/commerce-journey-functions.js';
import { parseCommerceEntity } from '../packages/ontology/commerce-journey.js';
import { setTimeout as pause } from 'node:timers/promises';
import { JobStore } from '../packages/core/store.js';
import { backend } from './backend-fixture.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Commerce sandbox is opt-in, owner scoped and cannot use live hosts or a live task', async () => {
  const t = await setupCommerce(); try {
    assert(!createExecutionCatalog().summaries(owner, 16, 'sandbox').some(c => c.ref.id === 'commerce.journey.sandbox'));
    assert(!t.catalog.summaries(owner).some(c => c.ref.id === 'commerce.journey.sandbox'));
    assert(!t.catalog.summaries('other', 16, 'sandbox').some(c => c.ref.id === 'commerce.journey.sandbox'));
    assert.equal(t.provider.audit().length, 0);
    assert.throws(() => new CommerceAgentProgram({ endpoint: 'https://merchant.example', tokenFile: t.tokenFile }), /127.0.0.1/);
    const env = { EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'x'.repeat(40), EIGOS_ACTION_SANDBOX: 'true', EIGOS_COMMERCE_SANDBOX_URL: t.provider.endpoint, EIGOS_COMMERCE_SANDBOX_TOKEN_FILE: t.tokenFile };
    assert.equal(readConfig(env).EIGOS_COMMERCE_SANDBOX_URL, readWorkerConfig(env).EIGOS_COMMERCE_SANDBOX_URL);
    for (const changed of [{ NODE_ENV: 'production' }, { EIGOS_ACTION_SANDBOX: 'false' }, { EIGOS_COMMERCE_SANDBOX_URL: 'http://localhost:1234' }, { EIGOS_COMMERCE_SANDBOX_TOKEN_FILE: 'relative' }]) assert.throws(() => readWorkerConfig({ ...env, ...changed }));
  } finally { await t.close(); }
});

test('Agent queries its PA context, merchant alternatives, inventory and cross-border facts before exact sandbox trade', async () => {
  const t = await setupCommerce(); try {
    const job = t.submit(); await t.b.run(); assert.equal(t.provider.audit().length, 0, 'Scope initialization makes no vendor calls');
    const done = await t.finish(job.id);
    assert.equal(done.state, 'completed', JSON.stringify({ error: done.error, question: done.question, feedback: done.delegation?.agent?.feedback, diagnostics:t.diagnostics, intents:t.store.intents(owner,done.id).map(i=>({step:i.stepId,effect:i.effect,state:i.state,failedQueries:i.failedQueries,lastMessage:i.lastResult?.message})) }));
    assert.equal(done.delegation!.acceptance!.accepted, true);
    const data = done.artifact!.data.result as any;
    assert.equal(data.environment, 'sandbox'); assert.equal(data.realOperationsAllowed, false);
    assert.equal(data.order.merchantId, 'cedar-ca'); assert.equal(data.destination.address.countryCode, 'CN'); assert.equal(data.destination.address.extendedAddress, '101 室');
    assert.equal(data.quote.groups.length, 2); assert(data.quote.groups.every((g: any) => g.dispatchCountry === 'US'));
    assert.equal(data.payment.state, 'settled'); assert.equal(data.delivery.state, 'delivered'); assert.equal(data.quote.buyerTotal.minor, '27000');
    assert(data.quote.components.filter((c: any) => ['tax','duty','clearance'].includes(c.category)).every((c: any) => c.payer === 'seller' && c.amountStatus === 'unknown' && c.responsibilityEvidence));
    const counts = t.provider.counts(); assert.equal(counts.ReadCommerceProduct, 2); assert.equal(counts.ReadCommerceInventory, 2);
    assert.equal(counts.CreateCommerceCart, 1); assert.equal(counts.PrepareCommerceCheckout, 1); assert.equal(counts.SubmitCommerceOrder, 1); assert.equal(counts.ReadCommerceOrder, 1);
    assert(t.provider.audit().every(a => a.modelRunId && a.planId && a.intentId && a.environment !== 'live'));
    const intents = t.store.intents(owner, done.id); assert(intents.every(i => i.state === 'effect_confirmed'));
    assert.equal(t.store.grants(owner, done.id).length, 3); assert.equal(t.store.budget(owner, done.id).filter((r: any) => r.state === 'consumed').length, 1);
    assert.equal(t.store.ontology.query(owner, { type: 'Order' }).items.length, 1); assert.equal(t.store.ontology.query(owner, { type: 'Payment' }).items.length, 1); assert.equal(t.store.ontology.query(owner, { type: 'DeliveryPromise' }).items.length, 6);
    const line = t.store.ontology.query(owner, { type: 'OrderLine' }).items[0]!; assert.deepEqual(t.store.ontology.evaluate(owner, { function: 'remainingQuantity', object: line.ref }).value, { amount: '0', unit: 'piece' });
  } finally { await t.close(); }
});

test('Agent first queries ambiguous PA context, asks only for a user choice, then continues the same task', async () => {
  const t = await setupCommerce({ scenario: { ambiguousAddress: true }, target: 'quote' }); try {
    const job = t.submit(), waiting = await t.finish(job.id);
    assert.equal(waiting.state, 'input-required'); assert.deepEqual(t.provider.audit().map(a => a.action), ['ReadCommerceContext', 'SearchCommerceMerchants']);
    assert.match(waiting.question!, /家庭地址/); assert.equal(t.provider.counts().SubmitCommerceOrder, undefined);
    t.b.tasks.reply(principal, { taskId: job.id, requestId: randomUUID(), answer: '使用家庭地址', requirements: [{ id: 'destination', kind: 'location', role: 'destination', strength: 'hard', expected: { ref: '家庭地址' } }] });
    const done = await t.finish(job.id); assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback)); assert.equal(done.id, job.id); assert.equal(done.delegation!.request.revision, 2);
    assert.equal((done.artifact!.data.result as any).destination.label, '家庭地址'); assert.equal(t.provider.counts().CreateCommerceCart, undefined);
  } finally { await t.close(); }
});

test('A cart-only goal needs no destination, customs, order or payment calls', async () => {
  const t = await setupCommerce({ target: 'cart', scenario: { ambiguousAddress: true } }); try {
    const done = await t.finish(t.submit().id); assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
    assert.deepEqual(t.provider.audit().map(a => a.action), ['SearchCommerceMerchants', 'ReadCommerceProduct', 'CreateCommerceCart']);
    assert.equal((done.artifact!.data.result as any).selected.inventoryReserved, false);
  } finally { await t.close(); }
});

test('An explicit user quantity remains known when grounding leaves the nullable field empty',async()=>{
  const t=await setupCommerce({target:'quote'});try{
    const ground=t.model.ground.bind(t.model);t.model.ground=async(...args)=>{const response=await ground(...args);assert('inputJson' in response.decision);response.decision.inputJson=JSON.stringify({...JSON.parse(response.decision.inputJson),quantity:null});return response;};
    const done=await t.finish(t.submit().id);assert.equal(done.state,'completed');assert.equal(done.delegation!.agent!.input.quantity,2);assert.equal(done.delegation!.agent!.informationRequests?.length??0,0);
  }finally{await t.close();}
});

test('Domestic available inventory changes the chosen merchant and route without changing the engine', async () => {
  const t = await setupCommerce({ target: 'quote', scenario: { domesticAvailable: true } }); try {
    const done = await t.finish(t.submit().id); assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
    const result = done.artifact!.data.result as any; assert.equal(result.selected.merchantId, 'harbor-cn'); assert.equal(result.selected.incoterm, 'domestic');
    assert.equal(t.provider.counts().ReadCommerceProduct, 1);
    const customs = t.store.ontology.query(owner, { type: 'CustomsAssessment' }).items[0]!; assert.equal((customs.properties.data as any).status, 'not_applicable');
  } finally { await t.close(); }
});

for (const [name, scenario, optionId] of [
  ['unknown buyer duties', {}, 'economy-dap'], ['restricted import', { importRestricted: true }, undefined], ['unresolved customs', { customsUnknown: true }, undefined], ['ETA without a commitment', { estimatedDeliveryOnly: true }, undefined],
] as const) test(`Unresolved purchase conditions block writes: ${name}`, async () => {
  const t = await setupCommerce({ target: 'quote', scenario, optionId }); try {
    const done = await t.finish(t.submit().id); assert.equal(done.state, 'rejected'); assert.equal(done.artifact, undefined);
    assert.equal(t.provider.counts().CreateCommerceCart, undefined); assert.equal(t.provider.counts().SubmitCommerceOrder, undefined);
  } finally { await t.close(); }
});

async function pendingOrder(t: Awaited<ReturnType<typeof setupCommerce>>, id: string) {
  for (let n=0;n<4;n++) { const waiting=await t.finish(id,false); assert.equal(waiting.state,'auth-required'); if(waiting.delegation!.authorizationRequest!.effects.includes('order'))return waiting; t.approve(waiting); }
  throw new Error('Expected an exact order and payment authorization');
}

test('Order and simulated payment need both exact effects; changed payees or excess amounts cannot be approved', async () => {
  const t=await setupCommerce();try{
    const id=t.submit().id,waiting=await pendingOrder(t,id),a=waiting.delegation!.authorizationRequest!;
    assert(a.environment === 'sandbox');
    assert.equal(t.provider.counts().SubmitCommerceOrder,undefined);
    assert.throws(()=>t.b.tasks.authorize(principal,id,{requestId:randomUUID(),action:'approve_plan',planDigest:a.planDigest,allowedEffects:a.effects,maxAmount:{...a.maxAmount,minor:String(BigInt(a.maxAmount.minor)+1n)},payeeIds:a.payeeIds,expiresAt:new Date(Date.now()+60000).toISOString(),environment:'sandbox'}),/exceeds/);
    t.approve(waiting,['order']);const held=await t.b.run();assert.equal(held.state,'auth-required');assert.equal(t.provider.counts().SubmitCommerceOrder,undefined);
    t.approve(held);const done=await t.finish(id);assert.equal(done.state,'completed');assert.equal(t.provider.counts().SubmitCommerceOrder,1);
  }finally{await t.close();}
});

test('Lost sandbox order response reads the original operation and never submits a second order', async () => {
  const t=await setupCommerce();try{
    const id=t.submit().id,waiting=await pendingOrder(t,id);t.approve(waiting);t.provider.flags.dropNextResponse='SubmitCommerceOrder';
    const unknown=await t.b.run();assert.equal(unknown.state,'working');assert.equal(t.provider.counts().SubmitCommerceOrder,1);
    const intent=t.store.intents(owner,id).find(i=>i.effect==='order')!;assert.equal(intent.state,'effect_unknown');
    const done=await t.finish(id);assert.equal(done.state,'completed',JSON.stringify(done.delegation?.agent?.feedback));assert.equal(t.provider.counts().SubmitCommerceOrder,1);
    assert.equal(t.store.attempts(owner,intent.id).filter(a=>a.kind==='dispatch').length,1);assert.equal(t.store.attempts(owner,intent.id).filter(a=>a.kind==='reconcile').length,1);
    assert(t.provider.audit().some(a=>String(a.path).startsWith('/operations/')&&a.operationKey===intent.businessOperationKey));
    assert.equal(t.store.intent(owner,intent.id).state,'effect_confirmed');
  }finally{await t.close();}
});

test('Unconfirmed transport failure preserves the original pending intent and budget without a new order plan',async()=>{
  const t=await setupCommerce();try{
    const id=t.submit().id,waiting=await pendingOrder(t,id);t.approve(waiting);t.provider.flags.dropBeforeDispatch='SubmitCommerceOrder';
    await t.b.run();const first=t.store.intents(owner,id).find(i=>i.effect==='order')!;
    const held=await t.finish(id);assert.equal(held.state,'input-required');assert(held.delegation!.agent!.pendingPlanId);assert.equal(t.store.intents(owner,id).filter(i=>i.effect==='order').length,1);
    assert.equal(t.store.intent(owner,first.id).state,'needs_review');assert.equal(t.provider.counts().SubmitCommerceOrder,undefined);assert.equal(t.store.budget(owner,id).find(r=>r.intent_id===first.id)!.state,'held');
    assert(!held.delegation!.agent!.feedback.some(f=>f.message.includes('already has an intent')));
  }finally{await t.close();}
});

test('A canceled in-flight order retains source evidence and only reads recovery, without projecting completion', async () => {
  const t=await setupCommerce();let release=()=>{};try{
    const id=t.submit().id,waiting=await pendingOrder(t,id);t.approve(waiting);
    let entered!:()=>void;const reached=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});
    t.provider.flags.beforeResponse=async action=>{if(action==='SubmitCommerceOrder'){entered();await held;}};
    const claim=t.store.claim(['eigos.delegate'],15000)!;
    const running=t.b.coordinator.run(claim,new AbortController().signal).finally(()=>t.store.release(claim));await Promise.race([reached,pause(3000).then(()=>{throw new Error('Expected committed sandbox effect');})]);
    t.b.tasks.cancel(principal,id);release();await running;delete t.provider.flags.beforeResponse;
    const canceled=t.store.get(owner,id);assert.equal(canceled.state,'canceled');assert.equal(canceled.artifact,undefined);assert.equal(t.store.ontology.query(owner,{type:'Order'}).items.length,0);
    assert.equal(t.provider.counts().SubmitCommerceOrder,1);
    await t.b.run();assert.equal(t.store.get(owner,id).state,'canceled');assert.equal(t.store.get(owner,id).delegation!.recoveryPending,false);
    assert.equal(t.store.intents(owner,id).find(i=>i.effect==='order')!.state,'effect_confirmed');assert.equal(t.store.ontology.query(owner,{type:'Order'}).items.length,0);
  }finally{release();await t.close();}
});

test('Revocation before order dispatch prevents the write, and cancellation never grants it', async () => {
  const t=await setupCommerce();try{
    const id=t.submit().id,waiting=await pendingOrder(t,id);t.approve(waiting);t.b.tasks.revokeAuthorization(principal,id,randomUUID());
    const revoked=t.store.get(owner,id);assert.equal(revoked.state,'auth-required');assert(t.store.grants(owner,id).every(g=>g.revoked));assert.equal(t.provider.counts().SubmitCommerceOrder,undefined);
    t.b.tasks.cancel(principal,id);assert.equal(t.store.get(owner,id).state,'canceled');assert.equal(t.provider.counts().SubmitCommerceOrder,undefined);
  }finally{await t.close();}
});

test('Revoking a consumed permit does not strand independent readback of the already submitted order',async()=>{
  const t=await setupCommerce();try{
    const id=t.submit().id,waiting=await pendingOrder(t,id);t.approve(waiting);await t.b.run();assert.equal(t.provider.counts().SubmitCommerceOrder,1);
    t.b.tasks.revokeAuthorization(principal,id,randomUUID());assert.equal(t.store.get(owner,id).state,'working');
    const done=await t.finish(id);assert.equal(done.state,'completed');assert.equal(t.provider.counts().SubmitCommerceOrder,1);assert(t.store.grants(owner,id).every(g=>g.revoked));
  }finally{await t.close();}
});

test('Lease replacement accepts only original-operation recovery and rejects the old late response',async()=>{
  const t=await setupCommerce();let release=()=>{};try{
    const id=t.submit().id,waiting=await pendingOrder(t,id);t.approve(waiting);
    let entered!:()=>void;const reached=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
    t.provider.flags.beforeResponse=async action=>{if(action==='SubmitCommerceOrder'){entered();await gate;}};
    const first=t.store.claim(['eigos.delegate'],15000)!,running=t.b.coordinator.run(first,new AbortController().signal);
    await reached;const replacement=t.store.claim(['eigos.delegate'],15000,Date.now()+20000)!;assert(replacement);
    const intent=t.store.intents(owner,id).find(i=>i.effect==='order')!;assert.equal(intent.state,'effect_unknown');intent.nextAt=0;t.store.saveIntent(owner,intent);
    release();await running;delete t.provider.flags.beforeResponse;assert.equal(t.store.ontology.query(owner,{type:'Order'}).items.length,0);
    await t.b.coordinator.run(replacement,new AbortController().signal);const done=await t.finish(id);
    assert.equal(done.state,'completed');assert.equal(t.provider.counts().SubmitCommerceOrder,1);assert.equal(t.store.attempts(owner,intent.id).filter(a=>a.kind==='dispatch').length,1);
  }finally{release();await t.close();}
});

test('A source stock change after approval rejects the old order without reserving a new payment',async()=>{
  const t=await setupCommerce();try{
    const id=t.submit().id,waiting=await pendingOrder(t,id);t.approve(waiting);t.provider.advanceStockVersion();
    await t.b.run();const intent=t.store.intents(owner,id).find(i=>i.effect==='order')!;
    assert.equal(intent.state,'rejected');assert.equal(t.provider.counts().SubmitCommerceOrder,undefined);assert.equal(t.store.budget(owner,id).find(r=>r.intent_id===intent.id)!.state,'released');
    assert.equal(t.store.ontology.query(owner,{type:'Order'}).items.length,0);
  }finally{await t.close();}
});

test('A saved-address room change after approval invalidates the original destination before order submission',async()=>{
  const t=await setupCommerce();try{
    const id=t.submit().id,waiting=await pendingOrder(t,id);t.approve(waiting);t.provider.setScenario({addressApartment:'102 室'});
    await t.b.run();const intent=t.store.intents(owner,id).find(i=>i.effect==='order')!;
    assert.equal(intent.state,'rejected');assert.equal(t.provider.counts().SubmitCommerceOrder,undefined);assert.match(intent.lastResult!.message!,/DESTINATION_CHANGED/);
  }finally{await t.close();}
});

test('A replacement runtime resumes a durable exact plan without repeating source actions', async () => {
  const directory=mkdtempSync(join(tmpdir(),'eigos-commerce-restart-')),t=await setupCommerce({databasePath:join(directory,'tasks.sqlite')});let second:JobStore|undefined;
  try{
    const id=t.submit().id,waiting=await pendingOrder(t,id);t.approve(waiting);const before=t.provider.audit().length;
    second=new JobStore(join(directory,'tasks.sqlite'));const b=backend(createExecutionCatalog({store:second,commerceSandbox:t.settings}),t.model,second,{allowSandbox:true});
    await b.run();assert.equal(t.provider.audit().length,before+1);assert.equal(t.provider.counts().SubmitCommerceOrder,1);
    const done=await t.finish(id);assert.equal(done.state,'completed');assert.equal(t.provider.counts().CreateCommerceCart,1);assert.equal(t.provider.counts().PrepareCommerceCheckout,1);
  }finally{second?.close();await t.close();rmSync(directory,{recursive:true,force:true});}
});

for(const [name,scenario] of [['pending payment',{paymentState:'pending'}],['partial delivery',{partialDelivery:true}],['future delivery',{futureDelivery:true}],['changed room identity',{wrongApartment:true}],['changed cost allocation',{changedOrderCosts:true}]] as const)test(`Completion cannot promote deficient source evidence: ${name}`,async()=>{
  const t=await setupCommerce({scenario});try{
    const done=await t.finish(t.submit().id);assert.equal(done.state,'paused');assert.equal(done.delegation!.recovery?.code,'validation_stalled');assert.equal(done.artifact,undefined);assert.equal(done.delegation!.acceptance,undefined);assert.equal(t.provider.counts().SubmitCommerceOrder,1);
  }finally{await t.close();}
});

test('Skipping the actual Ontology quote evaluation prevents checkout creation',async()=>{
  const choose=commerceChoice(),t=await setupCommerce({choice:(ctx,access)=>choose(ctx,{...access,session:new Proxy(access.session,{get(target,property,receiver){if(property==='call')return(tool:string,input:any)=>tool==='evaluate_ontology'&&input.object.type==='LandedCostQuote'?target.graph.evaluate(owner,input):target.call(tool,input);return Reflect.get(target,property,receiver);}})})});
  try{const done=await t.finish(t.submit().id);assert.equal(done.state,'paused');assert.equal(done.delegation!.recovery?.code,'validation_stalled');assert.equal(t.provider.counts().PrepareCommerceCheckout,undefined);assert(done.delegation!.agent!.feedback.some(f=>f.message.includes('must read and evaluate')));}
  finally{await t.close();}
});

test('Changing normalized fees and rehashing the snapshot cannot forge its original source payload',async()=>{
  const t=await setupCommerce({target:'quote'});try{
    const done=await t.finish(t.submit().id);assert.equal(done.state,'completed');
    const ref=done.delegation!.agent!.observations.find(r=>r.type==='LandedCostQuote')!,original=checkedCommerceObservation(t.store.ontology.read(owner,ref).properties.snapshot),changed=structuredClone(original);
    (changed.data.buyerTotal as {minor:string}).minor='1';const {contentDigest:_old,...body}=changed;changed.contentDigest=digest(body);
    assert.throws(()=>checkedCommerceObservation(changed),/source payload/);
    const quote=parseCommerceEntity('LandedCostQuote',original.data);quote.components.find(c=>c.category==='duty')!.payer='buyer';
    assert.equal(assessLandedCost(quote,[]).status,'unknown');
  }finally{await t.close();}
});
