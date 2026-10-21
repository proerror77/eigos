// Read-only independent observer. The actual PA submits, answers and authorizes.
// This program never submits a task, invokes a model or calls a business source.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { createHash, createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { digest, canonical } from '../packages/core/delegation.js';
import { readConfig } from '../packages/core/config.js';
import { CommerceAgentProgram } from '../packages/capabilities/commerce-agent.js';
import { sandboxResponseSchema } from '../packages/capabilities/commerce-sandbox/connector.js';
import { checkedCommerceObservation, sourcePayloadDigest, postalAddressDigest } from '../packages/ontology/commerce-journey-functions.js';
import { commerceActionMetadata, commerceJourneyInputSchema, parseCommerceEntity, type CommerceJourneyAction, type CommerceEntityType } from '../packages/ontology/commerce-journey.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { businessModel } from '../packages/ontology/business-model.js';
import type { Job } from '../packages/core/domain.js';
import type { ActionIntent, ExecutionAttempt, PlanGrant } from '../packages/ontology/actions.js';
import type { ObjectRef } from '../packages/ontology/model.js';
import { checkRequirements } from '../packages/coordinator/resolver.js';

assert(process.argv.includes('--observe'), 'Use --observe for the authorized PA sandbox evidence readback');
const index = process.argv.indexOf('--session-dir'); assert(index >= 0 && process.argv[index+1]);
const directory = resolve(process.argv[index+1]!), runtime = join(homedir(), '.local/share/eigos/grok-life'), sandboxRuntime = join(homedir(), '.local/share/eigos/commerce-sandbox');
const read = (path: string) => JSON.parse(readFileSync(path,'utf8'));
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const fileSha = (path: string) => sha(readFileSync(path));
const lines = (path: string, offset = 0) => readFileSync(path).subarray(offset).toString('utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
const session = read(join(directory,'session.json')), baseline = read(join(directory,'baseline.json')), deployment = read(join(directory,'deployment-before-pa.json')), sourceHashes = read(join(directory,'source-hashes.json'));
assert.equal(fileSha(session.inputFile),session.inputSha256,'Original PA task input changed');
const profile = read(join(runtime,'profile.json')); assert.equal(profile.cardUrl,'http://127.0.0.1:3430/.well-known/agent-card.json'); assert.deepEqual(profile.allowedServices,['eigos.delegate']);
assert.equal(lstatSync(profile.tokenFile).mode & 0o077,0);
const token = readFileSync(profile.tokenFile,'utf8').trim(), config = readConfig(parseEnv(readFileSync(join(runtime,'server.env'),'utf8')));
assert.equal(config.EIGOS_COMMERCE_SANDBOX_URL,'http://127.0.0.1:3432'); assert.equal(config.EIGOS_ACTION_SANDBOX,'true'); assert.equal(config.EIGOS_PAOTUI_ORDERS_ENABLED,'false'); assert.equal(config.EIGOS_EXECUTOR,'codex');
assert.deepEqual(config.EIGOS_SHOPIFY_CATALOG_MERCHANTS,baseline.shopifyMerchants); assert.deepEqual(config.EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES,baseline.publicGeoQueries);
for(const [file,hash]of Object.entries(baseline.files))assert.equal(fileSha(join(runtime,file)),hash,`Connection file changed: ${file}`);
const sandboxToken = readFileSync(config.EIGOS_COMMERCE_SANDBOX_TOKEN_FILE!,'utf8').trim(); assert.equal(fileSha(config.EIGOS_COMMERCE_SANDBOX_TOKEN_FILE!),baseline.sandboxTokenSha256);
const program = new CommerceAgentProgram({ endpoint: config.EIGOS_COMMERCE_SANDBOX_URL!, tokenFile: config.EIGOS_COMMERCE_SANDBOX_TOKEN_FILE! });
const submitted=read(join(directory,'pa-submit.json')),peer=read(join(directory,'pa-received.json')),original=read(join(directory,'artifact-original.json')),discovery=read(join(directory,'pa-discovery.json'));
assert.equal(submitted.id,peer.id);assert.equal(peer.status.state,'TASK_STATE_COMPLETED');assert.deepEqual(original,peer.artifacts[0]);assert.deepEqual(discovery.card.skills.map((s:any)=>s.id),['eigos.delegate']);
const client=new Client({name:'commerce-pa-independent-observer',version:'1'});
try{
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3430/mcp'),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
  const response=await client.callTool({name:'get_task',arguments:{taskId:peer.id}});assert(!response.isError);
  const job=(response.structuredContent as {result:Job}).result,d=job.delegation!,state=d.agent!,states=[...(d.agentHistory??[]),state],plans=states.flatMap(s=>s.plans);
  assert.equal(job.state,'completed');assert(d.acceptance?.accepted);assert.equal(d.backendVersion,'ontology-execution-v9');assert.equal(d.request.executionEnvironment,'sandbox');assert.equal(job.goal,read(session.inputFile).goal);assert.equal(job.messages[0]!.id,session.requestId);
  assert.equal(d.plan,undefined);assert.equal(d.resolution,undefined);assert.deepEqual(state.programRef,program.ref);assert.equal(state.programDigest,program.configurationDigest);assert(state.completion);
  assert.equal(canonical(peer.artifacts[0].parts[0].data),canonical(job.artifact!.data));
  assert(job.runs!.every(r=>r.runtime==='codex-exec'&&r.threadId&&/^[a-f0-9]{64}$/.test(r.outputSha256)));
  const run=(id:string)=>{const value=job.runs!.find(r=>r.id===id);assert(value);return value;};
  const owner=JSON.stringify(['local-development','local','developer']),db=new DatabaseSync(join(runtime,'tasks.sqlite'),{readOnly:true}),memory=new DatabaseSync(':memory:');
  const evaluations:unknown[]=[],observations:unknown[]=[];
  try{
    for(const old of baseline.oldJobs)assert.equal(sha(String(db.prepare('SELECT body FROM jobs WHERE id=?').get(old.id)!.body)),old.sha256,`Historical task changed: ${old.id}`);
    const persisted=JSON.parse(String(db.prepare('SELECT body FROM jobs WHERE owner=? AND id=?').get(owner,job.id)!.body)) as Job;
    assert.equal(digest(persisted.artifact),digest(job.artifact));assert.equal(db.prepare("SELECT count(*) AS n FROM jobs WHERE owner=? AND json_extract(body,'$.messages[0].id')=?").get(owner,session.requestId)!.n,1);
    const intents=db.prepare('SELECT body FROM action_intents WHERE owner=? AND job_id=?').all(owner,job.id).map(r=>JSON.parse(String(r.body)) as ActionIntent);
    const grants=db.prepare('SELECT body FROM plan_grants WHERE owner=? AND job_id=?').all(owner,job.id).map(r=>JSON.parse(String(r.body)) as PlanGrant);
    assert.equal(intents.length,plans.reduce((n,p)=>n+p.steps.length,0));assert(intents.every(i=>['effect_confirmed','rejected','canceled_before_dispatch'].includes(i.state)));
    for(const plan of plans){
      assert(plan.modelRunId && plan.modelDecision && !plan.callerDecision, 'Expected original model-selected source evidence');
      const {digest:hash,...body}=plan;assert.equal(digest(body),hash);assert.equal(plan.version,'2');assert.equal(plan.requestId,job.id);assert.equal(plan.programDigest,program.configurationDigest);assert.deepEqual(plan.ontologyPlanning.model,businessModel.ref);
      assert.equal(run(plan.modelRunId).decisionDigest,digest(plan.modelDecision));assert.equal(plan.steps.length,plan.modelDecision.steps.length);
      assert(plan.ontologyPlanning.reads.some(r=>r.tool==='describe_ontology'&&r.status==='ok'));assert(plan.ontologyPlanning.reads.some(r=>r.tool==='query_ontology'&&r.status==='ok'&&r.objects.some(o=>digest(o.ref)===digest(plan.scope))));
      for(const [i,step]of plan.steps.entries()){
        const {input,definitionDigest,intentId:_intent,operationKey:_key,effect:_effect,additionalEffects:_additional,cost:_cost,operationScope:_scope,...choice}=step;
        assert.deepEqual(choice,plan.modelDecision.steps[i]);assert.deepEqual(input,JSON.parse(step.argumentsJson));assert.equal(definitionDigest,digest(businessModel.action(step.action)));assert(program.actionIds.includes(step.action));
        const intent=intents.find(v=>v.id===step.intentId)!;assert(intent);assert.equal(intent.businessOperationKey,step.operationKey);assert.equal(intent.effect,step.effect);assert.equal(intent.planDigest,plan.digest);assert.equal(intent.inputDigest,digest({input:step.input,inputRefs:step.inputRefs}));
      }
    }
    // Reconstruct the wire request from the recorded model inputs and immutable
    // source objects, independently of the live connector's transport mapping.
    const object=(ref:ObjectRef)=>JSON.parse(String(db.prepare('SELECT body FROM ontology_objects WHERE owner=? AND type=? AND id=?').get(owner,ref.type,ref.id)!.body));
    function wirePayload(action:CommerceJourneyAction,input:Record<string,unknown>,at:string){
      const get=<T extends CommerceEntityType>(key:string,type:T)=>{const snapshot=checkedCommerceObservation(object(input[key] as ObjectRef).properties.snapshot);assert.equal(snapshot.type,type);assert(Date.parse(snapshot.observedAt)<=Date.parse(at));return{snapshot,data:parseCommerceEntity(type,snapshot.data)};};
      if(action==='ReadCommerceContext')return{contextKey:commerceJourneyInputSchema.parse(object(input.scope as ObjectRef).properties.input).contextKey??'default'};
      if(action==='SearchCommerceMerchants')return{query:input.query};
      if(action==='ReadCommerceProduct'){const budget=d.request.requirements.find(r=>r.kind==='budget');return{merchantId:input.merchantId,query:input.query,...(budget?.kind==='budget'?{currency:budget.expected.currency}:{})};}
      if(action==='ReadCommerceInventory'||action==='CreateCommerceCart'){const p=get('product','CommerceProduct').data;return{merchantId:p.merchantId,variantId:p.variantId,quantity:input.quantity,currency:p.unitPrice.currency};}
      if(action==='ReadCommerceFulfillment'){const p=get('product','CommerceProduct').data,i=get('inventory','InventoryObservation'),c=get('context','FulfillmentContext').data,a=c.addresses.find(a=>a.id===input.addressId);assert(a);return{merchantId:p.merchantId,variantId:p.variantId,quantity:input.quantity,inventoryId:i.snapshot.sourceId,contextKey:c.contextKey,addressId:a.id,addressRevision:a.revision,destinationDigest:postalAddressDigest(a.address),currency:p.unitPrice.currency};}
      if(action==='ReadCommerceCustoms'){const p=get('product','CommerceProduct').data;return{merchantId:p.merchantId,variantId:p.variantId,fulfillmentId:get('fulfillment','FulfillmentPlan').snapshot.sourceId,optionId:input.optionId};}
      if(action==='QuoteCommerceLandedCost'){const p=get('product','CommerceProduct').data;return{merchantId:p.merchantId,variantId:p.variantId,inventoryId:get('inventory','InventoryObservation').snapshot.sourceId,fulfillmentId:get('fulfillment','FulfillmentPlan').snapshot.sourceId,optionId:input.optionId,customsId:get('customs','CustomsAssessment').snapshot.sourceId};}
      if(action==='UpdateCommerceCart'){const c=get('cart','Cart').data,p=get('product','CommerceProduct').data;return{cartId:c.cartId,expectedRevision:c.revision,merchantId:p.merchantId,variantId:p.variantId,quantity:input.quantity,currency:p.unitPrice.currency};}
      if(action==='CancelCommerceCart'){const c=get('cart','Cart').data;return{cartId:c.cartId,expectedRevision:c.revision};}
      if(action==='ReadCommerceCart')return{cartId:get('cart','Cart').data.cartId};
      if(action==='PrepareCommerceCheckout'){const q=get('quote','LandedCostQuote');return{quoteId:q.snapshot.sourceId,sourceQuoteDigest:q.snapshot.receipt.payloadDigest,quoteDigest:q.snapshot.contentDigest,...(input.cart?{cartId:get('cart','Cart').data.cartId}:{})};}
      if(action==='SubmitCommerceOrder'){const c=get('checkout','CommerceCheckout').data;return{checkoutId:c.checkoutId,quoteDigest:c.quoteDigest,expectedTotal:c.total,expectedDestinationDigest:c.destinationDigest};}
      const o=get('order','CommerceOrderObservation').data;return{orderId:o.orderId,merchantId:o.merchantId};
    }
    const rows=lines(join(config.EIGOS_COMMERCE_SANDBOX_AUDIT_DIR!,'http.jsonl'),baseline.commerceAuditBytes).filter(r=>r.requestId===job.id);
    assert(rows.length>0);
    for(const row of rows){
      const plan=plans.find(p=>p.id===row.planId)!;assert(plan && plan.modelRunId && plan.modelDecision && !plan.callerDecision);const step=plan.steps.find(s=>s.intentId===row.intentId)!;assert(step);assert.equal(row.action,step.action);assert.equal(row.modelRunId,plan.modelRunId);assert.equal(row.operationKey,step.operationKey);
      const attempt=JSON.parse(String(db.prepare('SELECT body FROM action_attempts WHERE owner=? AND id=? AND intent_id=?').get(owner,row.attemptId,row.intentId)!.body)) as ExecutionAttempt;
      assert(Date.parse(run(plan.modelRunId).completedAt)<=Date.parse(attempt.startedAt));assert(Date.parse(attempt.startedAt)<=Date.parse(row.startedAt));assert.equal(attempt.kind,row.recovery?'reconcile':'dispatch');
      const materialized=structuredClone(step.input);
      for(const link of step.inputRefs){assert(step.dependsOn.includes(link.stepId));const dependency=plan.steps.find(s=>s.id===link.stepId);assert(dependency);const output=intents.find(i=>i.id===dependency.intentId)?.acceptedOutput?.object;assert(output);materialized[link.targetKey]=output;}
      // Attempts fence the mutable queue revision (also advanced by approvals);
      // the wire context below carries the pinned business request revision.
      assert.equal(attempt.planDigest,plan.digest);assert(attempt.requestRevision<=(job.revision??0));assert.equal(attempt.inputDigest,digest(row.recovery?{operationKey:step.operationKey}:materialized));
      assert.deepEqual(row.transportInput.context,{ownerDigest:digest(owner),requestId:job.id,requestRevision:plan.requestRevision,action:step.action,planId:plan.id,intentId:step.intentId,attemptId:attempt.id,modelRunId:plan.modelRunId,operationKey:step.operationKey});
      assert.deepEqual(row.transportInput.payload,row.recovery?null:wirePayload(step.action as CommerceJourneyAction,materialized,attempt.startedAt));
      assert.equal(row.environment,'sandbox');assert.equal(digest({method:row.method,path:row.path,context:row.transportInput.context,payload:row.transportInput.payload}),row.inputDigest);
      const bytes=readFileSync(join(config.EIGOS_COMMERCE_SANDBOX_AUDIT_DIR!,`${row.id}.json`));assert.equal(sha(bytes),row.responseSha256);assert.equal(bytes.length,row.responseBytes);assert.equal(createHmac('sha256',sandboxToken).update(bytes).digest('hex'),row.signature);
      const raw=JSON.parse(bytes.toString('utf8'));assert.deepEqual(raw.context,row.transportInput.context);
      if(row.status>=200&&row.status<300){const envelope=sandboxResponseSchema.parse(raw);assert.equal(envelope.environment,'sandbox');assert.equal(envelope.result.type,commerceActionMetadata[step.action as CommerceJourneyAction].type);assert.equal(envelope.source,commerceActionMetadata[step.action as CommerceJourneyAction].source);}
      else {assert.equal(typeof raw.error.applied,'boolean');if(raw.error.applied)assert(rows.some(r=>r.intentId===row.intentId&&r.recovery&&r.status===200&&Date.parse(r.receivedAt)>Date.parse(row.receivedAt)),'An applied or uncertain write needs original-operation readback');}
      if(row.recovery)assert(row.path.startsWith('/operations/'));else assert.equal(row.path,`/actions/${step.action}`);
      if(step.effect!=='read'&&!row.recovery){
        const grant=grants.find(g=>g.kind!=='object_write'&&g.planDigest===plan.digest&&!g.revoked&&g.bindingRefs.some(r=>digest(r)===digest(program.ref))&&[step.effect,...(step.additionalEffects??[])].every(e=>g.allowedEffects.includes(e))&&g.payeeIds.includes(step.cost!.payeeId)&&g.maxAmount.currency===step.cost!.currency&&BigInt(g.maxAmount.minor)>=BigInt(step.cost!.minor)&&Date.parse(g.approvedAt)<=Date.parse(attempt.startedAt)&&Date.parse(g.expiresAt)>Date.parse(attempt.startedAt));assert(grant,'Missing exact pre-dispatch PA authority');
      }
    }
    const sourceDb=new DatabaseSync(join(sandboxRuntime,'sandbox.sqlite'),{readOnly:true});let sourceAudit:any[];
    try{sourceAudit=sourceDb.prepare('SELECT body FROM audit WHERE ordinal>? ORDER BY ordinal').all(baseline.sourceAuditOrdinal).map(r=>JSON.parse(String(r.body))).filter(r=>r.requestId===job.id);}
    finally{sourceDb.close();}
    assert(sourceAudit.length>=rows.length);assert(sourceAudit.every(r=>r.ownerDigest===digest(owner)&&r.realOperationsAllowed===false));
    for(const row of rows)assert(sourceAudit.some(s=>s.attemptId===row.attemptId&&s.operationKey===row.operationKey&&s.action===row.action));
    for(const source of sourceAudit){
      const plan=plans.find(p=>p.id===source.planId),step=plan?.steps.find(s=>s.intentId===source.intentId);assert(plan&&step,'Unplanned source operation');
      assert.equal(source.action,step.action);assert.equal(source.modelRunId,plan.modelRunId);assert.equal(source.operationKey,step.operationKey);assert.equal(source.requestRevision,plan.requestRevision);
      const attempt=JSON.parse(String(db.prepare('SELECT body FROM action_attempts WHERE owner=? AND id=? AND intent_id=?').get(owner,source.attemptId,source.intentId)!.body)) as ExecutionAttempt;
      assert.equal(attempt.planDigest,plan.digest);assert(Date.parse(attempt.startedAt)<=Date.parse(source.at));
      const observed=rows.find(r=>r.attemptId===source.attemptId);
      if(observed?.status===200){const envelope=sandboxResponseSchema.parse(read(join(config.EIGOS_COMMERCE_SANDBOX_AUDIT_DIR!,`${observed.id}.json`)));assert.equal(source.responsePayloadDigest,sourcePayloadDigest(envelope.result));}
    }
    const required=['ReadCommerceContext','SearchCommerceMerchants','ReadCommerceProduct','ReadCommerceInventory','ReadCommerceFulfillment','ReadCommerceCustoms','QuoteCommerceLandedCost','CreateCommerceCart','PrepareCommerceCheckout','SubmitCommerceOrder','ReadCommerceOrder','ReadCommercePayment','ReadCommerceDelivery'];
    for(const action of required)assert(rows.some(r=>r.action===action&&r.status===200),`Missing actual selected source action: ${action}`);
    const purchase=intents.filter(i=>i.effect==='order');assert.equal(purchase.length,1);assert.equal(db.prepare('SELECT count(*) AS n FROM action_attempts WHERE owner=? AND intent_id=? AND json_extract(body,\'$.kind\')=\'dispatch\'').get(owner,purchase[0]!.id)!.n,1);

    // Work on an isolated in-memory copy to replay earlier request revisions.
    new OntologyObjectStore(memory,businessModel);
    for(const table of ['ontology_objects','ontology_links','ontology_revisions'])for(const row of db.prepare(`SELECT * FROM ${table} WHERE owner=?`).all(owner)){const values=Object.values(row);memory.prepare(`INSERT INTO ${table} VALUES(${values.map(()=>'?').join(',')})`).run(...values);}
    const originalRoot=readRoot();
    function readRoot(){return JSON.parse(String(memory.prepare("SELECT body FROM ontology_objects WHERE owner=? AND type='ServiceRequest' AND id=?").get(owner,job.id)!.body));}
    function replay(revision:number,at:string){const root=structuredClone(originalRoot);root.properties.revision=revision;memory.prepare("UPDATE ontology_objects SET body=? WHERE owner=? AND type='ServiceRequest' AND id=?").run(JSON.stringify(root),owner,job.id);return new OntologyObjectStore(memory,businessModel,()=>Date.parse(at));}
    for(const s of states)for(const ref of s.observations){
      const graph=replay(s.requestRevision,job.updatedAt),record=graph.read(owner,ref),observation=checkedCommerceObservation(record.properties.snapshot);observations.push({object:ref,snapshot:observation});
      assert.equal(record.source.kind,'synthetic');assert.equal(observation.evidenceLevel,'synthetic');assert.equal(observation.requestId,job.id);assert.equal(observation.configurationDigest,program.configurationDigest);
      const row=rows.find(r=>r.id===observation.receipt.id);assert(row);const raw=sandboxResponseSchema.parse(read(join(config.EIGOS_COMMERCE_SANDBOX_AUDIT_DIR!,`${row.id}.json`)));
      assert.equal(sourcePayloadDigest(raw.result),observation.receipt.payloadDigest);assert.deepEqual(raw.result.data,observation.data);assert.equal(raw.result.sourceId,observation.sourceId);assert.equal(raw.result.sourceVersion,observation.sourceVersion);
    }
    const questions=states.flatMap(s=>(s.informationRequests??[]).map(q=>({...q,requestRevision:s.requestRevision})));
    assert.equal(questions.filter(q=>q.decision.informationRequest?.fact==='destination_choice').length,1,'Expected one evidenced PA address choice');
    const question=questions.find(q=>q.decision.informationRequest?.fact==='destination_choice')!;
    assert.equal(run(question.modelRunId).decisionDigest,digest(question.decision));
    const contextRef=question.decision.informationRequest!.evidenceRefs.find(r=>r.type==='FulfillmentContext')!;assert(contextRef);
    const evalInput={function:'commerceObservationStatus',object:contextRef},questionRead=question.ontologyPlanning.reads.find(r=>r.tool==='evaluate_ontology'&&r.inputDigest===digest(evalInput)&&r.status==='ok')!;assert(questionRead);
    const contextStatus=replay(question.requestRevision,questionRead.at).evaluate(owner,evalInput);assert.equal(digest(contextStatus),questionRead.outputDigest);assert.equal(contextStatus.status,'known');assert((contextStatus.value as any).assessment.gaps.some((g:any)=>g.fact==='destination_choice'));
    assert(rows.some(r=>r.action==='ReadCommerceContext'&&Date.parse(r.receivedAt)<Date.parse(question.at)));
    const replies=job.messages.filter(m=>m.role==='user'&&m.id!==session.requestId);assert.equal(replies.length,1);assert.equal(replies[0]!.id,session.replyRequestId);assert(Date.parse(replies[0]!.at)>=Date.parse(question.at));assert(replies[0]!.text.includes(session.expectedAddressLabel));
    assert(!job.goal.includes(session.expectedAddressLabel));assert(!job.goal.includes('cedar-ca'));assert(!job.goal.includes('harbor-cn'));assert(!job.goal.includes('101 室'));
    const complete=state.completion!;assert.equal(run(complete.modelRunId).decisionDigest,digest(complete.modelDecision));assert.deepEqual(complete.proposal,JSON.parse(complete.modelDecision.completionJson));
    for(const value of Object.values(complete.proposal as Record<string,unknown>)){
      if(!value||typeof value!=='object'||!('type'in value)||!('id'in value))continue;
      const ref=value as ObjectRef,input={function:'commerceObservationStatus',object:ref},read=complete.ontologyPlanning.reads.find(r=>r.tool==='evaluate_ontology'&&r.status==='ok'&&r.inputDigest===digest(input));assert(read);
      const status=replay(state.requestRevision,read.at).evaluate(owner,input);assert.equal(status.status,'known');assert.equal(digest(status),read.outputDigest);assert.equal((status.value as any).assessment.status,'satisfied');evaluations.push({object:ref,receipt:read,status});
    }
    const finalGraph=replay(state.requestRevision,job.updatedAt), independentlyCompleted=program.complete({graph:finalGraph,owner,request:d.request,state,intents},complete.proposal,complete.ontologyPlanning);
    assert.equal(digest(independentlyCompleted.artifact),digest(job.artifact));
    const requirements=[...d.request.requirements,...(d.request.successCriteria??[])],checks=checkRequirements({...d.request,requirements},independentlyCompleted.facts,independentlyCompleted.evidenceRefs,supported(),program.capability().locationSemantics);
    function supported(){const cap=program.capability();return[...cap.predicates.map(p=>p.id),...(cap.outcomePredicates??[])];}
    assert.deepEqual(checks,d.acceptance!.checks);assert(requirements.filter(r=>r.strength==='hard').every(r=>checks.some(c=>c.requirementId===r.id&&c.result==='pass')));
    const result=job.artifact!.data.result as any;assert.equal(result.environment,'sandbox');assert.equal(result.realOperationsAllowed,false);assert.equal(result.target,'delivery');assert.equal(result.destination.label,session.expectedAddressLabel);assert.equal(result.destination.address.extendedAddress,'101 室');assert.equal(result.destination.address.countryCode,'CN');
    assert.equal(result.order.merchantId,'cedar-ca');assert.equal(result.quote.buyerTotal.currency,'CNY');assert.equal(result.quote.buyerTotal.minor,'27000');assert(result.quote.groups.every((g:any)=>g.dispatchCountry==='US'));assert.equal(result.quote.groups.length,2);assert.equal(result.payment.state,'settled');assert.equal(result.delivery.state,'delivered');assert.equal(result.delivery.events.reduce((n:number,e:any)=>n+e.quantity,0),2);
    const product=(observations as any[]).map(o=>o.snapshot).find(o=>o.type==='CommerceProduct'&&o.data.merchantId===result.order.merchantId);assert(product);assert.equal(product.data.goodsOriginCountry,'BR');
    const merchant=(observations as any[]).filter(o=>o.snapshot.type==='CommerceMerchantSearch').flatMap(o=>o.snapshot.data.merchants).find((m:any)=>m.id===result.order.merchantId);assert.equal(merchant.registeredCountry,'CA');
    assert(result.quote.components.filter((c:any)=>['tax','duty','clearance'].includes(c.category)).every((c:any)=>c.payer==='seller'&&c.coveredByTotal&&c.responsibilityEvidence));
    const orderRef={type:'Order',id:digest({environment:'commerce-sandbox',configuration:program.configurationDigest,merchant:result.order.merchantId,providerId:result.order.orderId,type:'Order'})};
    const canonicalOrder=finalGraph.read(owner,orderRef),payments=finalGraph.related(owner,orderRef,'payments',{remaining:1000})??[],shipments=finalGraph.related(owner,orderRef,'shipments',{remaining:1000})??[],orderLines=finalGraph.related(owner,orderRef,'lines',{remaining:1000})??[];
    assert.equal(canonicalOrder.properties.orderState,'confirmed');assert.deepEqual(canonicalOrder.properties.total,result.order.total);assert.equal(payments.length,1);assert.equal(payments[0]!.properties.paymentState,'paid');assert.deepEqual(payments[0]!.properties.amount,result.payment.amount);assert.equal(shipments.length,2);assert(shipments.every(s=>s.properties.shipmentState==='delivered'));assert.equal(orderLines.length,1);
    const remaining=finalGraph.evaluate(owner,{function:'remainingQuantity',object:orderLines[0]!.ref});assert.equal(remaining.status,'known');assert.deepEqual(remaining.value,{amount:'0',unit:'piece'});
    const allocations=finalGraph.related(owner,orderLines[0]!.ref,'allocations',{remaining:1000})??[];assert.equal(allocations.length,2);assert(allocations.every(a=>a.properties.verificationState==='accepted'));
    const canonicalGraphReadback={order:canonicalOrder,payments,shipments,orderLines,allocations,remaining};
    const http=lines(join(runtime,'http.jsonl'),baseline.httpAuditBytes),a2a=http.filter(r=>r.path==='/a2a'&&(r.taskId===job.id||r.messageId===session.requestId||r.messageId===session.replyRequestId));
    const externalCatalogReads=lines(join(config.EIGOS_SHOPIFY_AUDIT_DIR!,'reads.jsonl'),baseline.shopifyAuditBytes).filter(r=>r.requestId===job.id);
    assert.equal(externalCatalogReads.length,0,'This sandbox task must not call the real Shopify source');
    assert.equal(a2a.filter(r=>r.method==='SendMessage'&&r.messageId===session.requestId).length,1);assert.equal(a2a.filter(r=>r.method==='SendMessage'&&r.messageId===session.replyRequestId).length,1);assert(a2a.some(r=>r.method==='GetTask'&&r.taskId===job.id&&Date.parse(r.at)>=Date.parse(job.updatedAt)));
    const approvals=http.filter(r=>r.path===`/tasks/${job.id}/authorize`);assert(approvals.length>=3);assert(approvals.every(r=>r.httpStatus===200));
    for(const root of [runtime,sandboxRuntime]){const release=read(join(root,'release.json')),expected=root===runtime?deployment.release:deployment.sandboxRelease,hash=createHash('sha256');for(const file of release.files){const bytes=readFileSync(join(release.release,file));assert(bytes.equals(readFileSync(resolve(file))),`Compiled file differs: ${file}`);hash.update(file+'\0');hash.update(bytes);}assert.equal(hash.digest('hex'),release.buildDigest);assert.equal(release.buildDigest,expected.buildDigest);}
    for(const [file,hash]of Object.entries(sourceHashes.sha256))assert.equal(fileSha(resolve(file)),hash,`Source changed after PA submission: ${file}`);
    const health=await fetch('http://127.0.0.1:3430/health').then(r=>r.json());assert.equal(health.backend,'ontology-execution-v9');assert.equal(health.releaseDigest,deployment.release.buildDigest);
    const evidence={passed:true,recordedAt:new Date().toISOString(),scope:'Actual Monk PA -> A2A -> actual EIGOS LLM and Ontology -> signed isolated commerce simulator -> independent original order/payment/delivery -> PA; business facts and effects are synthetic',taskId:job.id,requestId:session.requestId,replyRequestId:session.replyRequestId,createdAt:job.createdAt,completedAt:job.updatedAt,backend:d.backendVersion,businessModel:businessModel.ref,configurationDigest:program.configurationDigest,buildDigest:deployment.release.buildDigest,sandboxBuildDigest:deployment.sandboxRelease.buildDigest,previousJobsUnchanged:baseline.oldJobs.length,credentialAndAllowlistReadback:true,sourceFrozenAt:sourceHashes.capturedBeforeRun,sourceManifestSha256:fileSha(join(directory,'source-hashes.json')),modelReceipts:job.runs,ontologyReads:d.ontologyReads,plans,informationRequests:questions,completion:complete,sourceReads:rows,sourceAudit,observations,evaluations,grants,intents:intents.map(({privateData:_private,...intent})=>intent),acceptance:d.acceptance,result,a2aTrace:a2a,authorizationTrace:approvals,realOrders:0,realPayments:0,paArtifactDigest:digest(peer.artifacts[0].parts[0].data),observerArtifactDigest:digest(job.artifact!.data),originalArtifactFileSha256:fileSha(join(directory,'artifact-original.json')),paReceivedFileSha256:fileSha(join(directory,'pa-received.json'))};
    const modelFeedback=states.flatMap(s=>s.feedback.map(f=>({...f,requestRevision:s.requestRevision})));
    const serialized=JSON.stringify({...evidence,canonicalGraphReadback,modelFeedback},null,2)+'\n';assert(!serialized.includes(token));assert(!serialized.includes(sandboxToken));writeFileSync(join(directory,'verification.json'),serialized,{mode:0o600});
    console.log(JSON.stringify({passed:true,taskId:job.id,modelCalls:job.runs!.length,plans:plans.length,sourceCalls:rows.length,paQuestions:questions.length,grants:grants.length,realTransactions:0,buildDigest:deployment.release.buildDigest}));
  }finally{memory.close();db.close();}
}finally{await client.close();}
