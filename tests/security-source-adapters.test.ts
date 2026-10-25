import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {securedProgramFixture} from './fixtures/secured-program.js';
import {fixture as catalogFixture,merchant,input as catalogInput,ids} from './fixtures/catalog-agent.js';
import {meituanPrimitiveFixture,missingMeituan} from './fixtures/meituan-agent.js';
import {CatalogAgentProgram} from '../packages/capabilities/catalog-agent.js';
import {MeituanReadProgram} from '../packages/capabilities/meituan-agent.js';
import type {AgentPlanningContext,PlanningAccess} from '../packages/coordinator/coordinator.js';
import type {AgentDecision,AgentStep} from '../packages/ontology/agent-actions.js';
import type {ObjectRef} from '../packages/ontology/model.js';
import {readConfig} from '../packages/core/config.js';
import {bindPersonalSourceOwner} from '../packages/core/source-owner.js';
import {participantFixture} from './fixtures/free-booking.js';
import {ParticipantBookingProgram} from '../packages/capabilities/free-booking/program.js';
import {BookingAgentProgram} from '../packages/capabilities/booking/program.js';
import {securityFixture} from './fixtures/security.js';
import {createBookingSandboxProvider} from '../packages/capabilities/booking/sandbox.js';
import {createCommerceSandboxProvider} from '../packages/capabilities/commerce-sandbox/provider.js';
import {writeFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../apps/gateway/app.js';
import {OntologyPlanningSession} from '../packages/coordinator/planning-session.js';
import {digest} from '../packages/core/delegation.js';
import {setupPABooking} from './fixtures/pa-booking.js';
import {CommerceAgentProgram} from '../packages/capabilities/commerce-agent.js';
import {setupCommerce,commercePolicyReads} from './fixtures/commerce-agent.js';

const step=(action:string,input:object):AgentStep=>({id:action,action,argumentsJson:JSON.stringify(input),dependsOn:[],inputRefs:[]});
const decision=(ctx:AgentPlanningContext,steps:AgentStep[],result?:object):AgentDecision=>({kind:result?'complete':'execute',requestRevision:ctx.request.revision,message:'Synthetic choice from currently authorized observations',steps,completionJson:result?JSON.stringify(result):''});
function reads(ctx:AgentPlanningContext,access:PlanningAccess,fn:string) {
  access.session.call('describe_ontology',{search:ctx.state.scope.type,limit:5});
  access.session.call('query_ontology',{object:{type:'ServiceRequest',id:ctx.request.id}});
  access.session.call('query_ontology',{object:ctx.state.scope});
  return ctx.state.observations.map(ref=>{
    const query=access.session.call('query_ontology',{object:ref}) as {items:{properties:Record<string,any>}[]};
    const status=access.session.call('evaluate_ontology',{function:fn,object:ref}) as {status:string;reason?:string};assert.equal(status.status,'known',status.reason);
    return {ref,value:query.items[0]!.properties.observedData};
  });
}

test('native Shopify program uses a single explicit source owner and delivers typed observations without internal snapshots',async()=>{
  const source=catalogFixture(),f=securedProgramFixture(()=>new CatalogAgentProgram([merchant],{connector:source.connector}),catalogInput,(ctx,access)=>{
    const observed=reads(ctx,access,'catalogObservationStatus');
    return observed.length?decision(ctx,[],{selections:[{observation:observed[0]!.ref,variantIds:[ids[2]]}],rationale:'The selected current variant is available in the requested source'}):decision(ctx,[step('SearchPublicCatalog',{scope:ctx.state.scope,merchantId:merchant.id,query:'coffee',limit:4})]);
  });
  try {
    assert.equal(f.program.permitted(f.owner),true);assert.equal(f.program.permitted('["https://migration.example","tenant","other"]'),false);
    assert.throws(()=>bindPersonalSourceOwner(f.program,'["different","tenant","other"]'),/immutable/);
    const job=f.tasks.submit(f.p,{service:'eigos.delegate',requestId:randomUUID(),goal:'Read the third coffee variant from the configured merchant'});
    const done=await f.advance(job.id);assert.equal(done.state,'completed',JSON.stringify(done.delegation?.agent?.feedback));const view=f.tasks.get(f.p,job.id),text=JSON.stringify(view);assert.ok(text.includes(ids[2]!));assert.ok(!text.includes('configurationDigest'));assert.ok(!text.includes('"snapshot":'));assert.equal(source.calls.length,1);
    assert.ok(!f.modelInputs.join('\n').includes('"receipt":'));
  }finally{f.close();}
});

for(const mode of ['geo','addresses','delivery'] as const)test(`native Meituan ${mode} separates Worker facts from explicitly authorized PA address output`,async()=>{
  const source=meituanPrimitiveFixture(),input=mode==='geo'?{city:'北京市',keyword:'公园'}:mode==='addresses'?{}:{...missingMeituan,sender:'测试住处',recipient:'测试办公室'};
  const f=securedProgramFixture(f=>new MeituanReadProgram(mode,source.reader,f.jobs),input,(ctx,access)=>{
    const obs=reads(ctx,access,'meituanReadStatus'),scope=ctx.state.scope;
    const final=obs.find(o=>o.value.data.kind===(mode==='geo'?'locations':mode==='addresses'?'addresses':'quote'));
    if(final) {
      if(mode==='addresses') {
        const blocked=access.session.call('query_ontology',{object:final.ref,select:['addressBook']});assert.ok(JSON.stringify(blocked).includes('INSUFFICIENT_ACCESS'));assert.ok(!JSON.stringify(blocked).includes('张某'));
      }
      return decision(ctx,[],{observation:final.ref,rationale:'Current source observation covers the requested read'});
    }
    if(mode==='geo')return decision(ctx,[step('SearchMeituanLocations',{scope})]);
    const book=obs.find(o=>o.value.data.kind==='addresses');if(!book)return decision(ctx,[step('ReadMeituanAddresses',{scope})]);
    const sender=obs.find(o=>o.value.data.kind==='address_detail' && o.value.data.role==='sender'),recipient=obs.find(o=>o.value.data.kind==='address_detail' && o.value.data.role==='recipient');
    if(!sender || !recipient)return decision(ctx,[...(sender?[]:[step('ReadMeituanSenderDetails',{scope,addresses:book.ref})]),...(recipient?[]:[step('ReadMeituanRecipientDetails',{scope,addresses:book.ref})])]);
    return decision(ctx,[step('EstimateMeituanDelivery',{scope,addresses:book.ref,sender:sender.ref,recipient:recipient.ref})]);
  });
  try {
    const goal=mode==='delivery'?'查询测试住处到测试办公室寄送一公斤文件的普通送价格':mode==='addresses'?'读取本人保存地址':'查询北京公园';
    const job=f.tasks.submit(f.p,{service:'eigos.delegate',requestId:randomUUID(),goal});
    const done=await f.advance(job.id);assert.equal(done.state,'completed',JSON.stringify(done.delegation?.agent?.feedback));
    const model=f.modelInputs.join('\n');assert.ok(!model.includes('13800001111'));assert.ok(!model.includes('张某'));assert.ok(!model.includes('private-a'));assert.ok(!model.includes('"snapshot":'));
    const view=JSON.stringify(f.tasks.get(f.p,job.id));assert.ok(!view.includes('13800001111'));if(mode==='addresses')assert.ok(view.includes('测试住处') && view.includes('张某'));if(mode==='delivery')assert.ok(view.includes('12.50'));
    assert.ok(source.calls.every(c=>['search_poi','get_address_list','get_address_info','delivery_preview'].includes(c.tool)));
  }finally{f.close();}
});

test('personal source configuration stays closed without exact foundation owner binding and a local listener',()=>{
  const env={EIGOS_SECURITY_MODE:'foundation',EIGOS_AUTH_MODE:'jwt',HOST:'127.0.0.1',PUBLIC_URL:'https://private.example',DATABASE_PATH:'/tmp/isolated.sqlite',OAUTH_ISSUER:'https://identity.example',OAUTH_JWKS_URL:'https://identity.example/jwks',OAUTH_AUDIENCE:'https://private.example',OIDC_AGENT_CLIENT_ID:'registered-agent',EIGOS_PAOTUI_SKILL_DIR:'/private/known-skill'};
  assert.throws(()=>readConfig(env),/Personal Paotui/);
  const configured={...env,EIGOS_PERSONAL_SOURCE_OWNER:'["https://identity.example","tenant","member"]'};assert.equal(readConfig(configured).EIGOS_AUTH_MODE,'jwt');assert.throws(()=>readConfig({...configured,HOST:'0.0.0.0'}),/loopback listener/);assert.throws(()=>readConfig({...configured,NODE_ENV:'production'}),/loopback listener/);
});

test('the real Gateway starts bound personal sources without invoking them or granting access',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'eigos-bound-source-start-')),owner='["https://identity.example","tenant","member"]';
  try {
    const audit=join(directory,'source-reads.jsonl');
    const config=readConfig({EIGOS_SECURITY_MODE:'foundation',EIGOS_AUTH_MODE:'jwt',HOST:'127.0.0.1',PUBLIC_URL:'https://private.example',
      DATABASE_PATH:join(directory,'tasks.sqlite'),OAUTH_ISSUER:'https://identity.example',OAUTH_JWKS_URL:'https://identity.example/jwks',
      OAUTH_AUDIENCE:'https://private.example',OIDC_AGENT_CLIENT_ID:'registered-agent',EIGOS_PERSONAL_SOURCE_OWNER:owner,
      EIGOS_PAOTUI_SKILL_DIR:join(directory,'unconnected-source'),EIGOS_ONTOLOGY_AUDIT_PATH:audit});
    for(const rejected of [{...config,EIGOS_PERSONAL_SOURCE_OWNER:undefined},{...config,EIGOS_PERSONAL_SOURCE_OWNER:'unverified'},
      {...config,HOST:'0.0.0.0'},{...config,PUBLIC_URL:'http://private.example'},{...config,EIGOS_SECURITY_MODE:'legacy' as const}]) {
      assert.throws(()=>createApp(rejected),/Paotui requires/);
    }
    const gateway=createApp(config);
    try {
      assert.equal(gateway.catalog.securityProfiles(owner).length,4);
      assert.equal(gateway.catalog.securityProfiles('["https://identity.example","tenant","other"]').length,0);
      assert.equal(gateway.store.security.listGrants(owner).length,0);
      assert.equal(existsSync(audit),false);
    }finally{await gateway.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('foundation native definitions fit the bounded prepared context without full property schemas',async()=>{
  const source=catalogFixture(),f=securedProgramFixture(()=>new CatalogAgentProgram([merchant],{connector:source.connector}),catalogInput,()=>{
    assert.fail('Preparing definitions must not make an action decision');
  });
  try {
    const job=f.tasks.submit(f.p,{service:'eigos.delegate',requestId:randomUUID(),goal:'Read a configured public catalog'});
    await f.tick();
    const current=f.jobs.get(f.owner,job.id),request=current.delegation!.request,scope=current.delegation!.agent!.scope;
    const prepared=f.jobs.security.withAgent(f.p,job.id,'task.query',()=>{
      const session=new OntologyPlanningSession(f.jobs.ontology,f.owner,request,[],()=>{},()=>{},'request',[scope]);
      const context=session.prepareContext({actions:[...f.program.actionIds],refs:[scope]});
      return {context,receipts:session.receipts()};
    });
    const definitions=prepared.context.entries[0]!.result as {error?:string;types:{properties:Record<string,{schema?:unknown}>}[];actions:{read?:{inputSchema:unknown}}[]};
    assert.equal(prepared.receipts[0]!.status,'ok',JSON.stringify(definitions));
    assert.ok(prepared.receipts[0]!.outputBytes!<=30000);
    assert.ok(definitions.types.every(t=>Object.values(t.properties).every(p=>!Object.hasOwn(p,'schema'))));
    assert.ok(definitions.actions.length>0 && definitions.actions.every(a=>a.read?.inputSchema));
    assert.equal(source.calls.length,0);
  }finally{f.close();}
});

test('native participant read delivers an independent registration without private account references',async()=>{
  const source=participantFixture(),f=securedProgramFixture(()=>new ParticipantBookingProgram(source.source),source.input,(ctx,access)=>{
    const observed=reads(ctx,access,'registrationStatus');return observed.length?decision(ctx,[],{registration:observed[0]!.ref,rationale:'Independently read the existing synthetic registration'}):decision(ctx,[step('ReadParticipantRegistration',{scope:ctx.state.scope})]);
  });
  try {
    const job=f.tasks.submit(f.p,{service:'eigos.delegate',requestId:randomUUID(),goal:'Read an existing synthetic registration',executionEnvironment:'sandbox'}),done=await f.advance(job.id);
    assert.equal(done.state,'completed',JSON.stringify(done.delegation?.agent?.feedback));const view=JSON.stringify(f.tasks.get(f.p,job.id));assert.ok(view.includes('synthetic-registration'));assert.ok(!view.includes(source.source.attendeeRef));assert.ok(!view.includes('synthetic-confirmation'));assert.equal(source.counters().submits,0);
  }finally{f.close();source.store.close();}
});

test('native sandbox booking carries an exact reserve permit and returns only safe confirmation fields',async()=>{
  const base=securityFixture(),provider=await createBookingSandboxProvider({ownerKey:base.owner}),source=await setupPABooking({provider});source.provider.flags.freeBooking=true;
  const f=securedProgramFixture(()=>new BookingAgentProgram(source.settings),{query:'consultation',participants:1,startsAt:null},(ctx,access)=>{
    const observed=reads(ctx,access,'bookingObservationStatus'),offers=observed.find(v=>v.ref.type==='BookingOffers'),booking=observed.filter(v=>v.ref.type==='BookingObservation').at(-1),scope=ctx.state.scope;
    if(!offers)return decision(ctx,[step('SearchBookingOffers',{scope,query:'consultation'})]);
    if(!booking)return decision(ctx,[step('CreatePendingBooking',{scope,offers:offers.ref,offerId:offers.value.offers[0].id})]);
    if(!booking.value.independentRead)return decision(ctx,[step('ReadProviderBooking',{scope,booking:booking.ref})]);
    return decision(ctx,[],{booking:booking.ref,rationale:'Independently confirmed the synthetic free reservation'});
  },base);
  try {
    const job=f.tasks.submit(f.p,{service:'eigos.delegate',requestId:randomUUID(),goal:'Confirm a synthetic free booking',executionEnvironment:'sandbox'}),waiting=await f.advance(job.id);
    assert.equal(waiting.state,'auth-required',JSON.stringify(waiting.delegation?.agent?.feedback));const a=waiting.delegation!.authorizationRequest!;
    f.tasks.authorize(f.p,job.id,{action:'approve_plan',requestId:randomUUID(),planDigest:a.planDigest,allowedEffects:a.effects,maxAmount:a.maxAmount,payeeIds:a.payeeIds,expiresAt:new Date(Date.now()+60000).toISOString(),environment:'sandbox'});
    const done=await f.advance(job.id);assert.equal(done.state,'completed',JSON.stringify(done.delegation?.agent?.feedback));const view=JSON.stringify(f.tasks.get(f.p,job.id));assert.ok(view.includes('confirmed'));assert.ok(!view.includes('paymentHandler'));assert.ok(!view.includes('/checkout/'));assert.ok(!f.modelInputs.join('\n').includes('paymentHandler'));
  }finally{f.close();await source.close();await provider.close();}
});

test('native commerce quote completes through typed facts and reviewed customs references without any write',async()=>{
  const base=securityFixture(),provider=await createCommerceSandboxProvider({ownerDigests:[digest(base.owner)],scenario:{domesticAvailable:true,ambiguousAddress:false}}),tokenFile=join(base.directory,'source-token');writeFileSync(tokenFile,provider.token,{mode:0o600});
  const f=securedProgramFixture(()=>new CommerceAgentProgram({endpoint:provider.endpoint,tokenFile}),{query:'coffee',quantity:2,contextKey:null,target:'quote'},(ctx,access)=>{
    const values=reads(ctx,access,'commerceObservationStatus'),last=(type:string)=>values.filter(v=>v.ref.type===type).at(-1),scope=ctx.state.scope;
    const context=last('FulfillmentContext'),directory=last('CommerceMerchantSearch'),product=last('CommerceProduct'),inventory=last('InventoryObservation'),route=last('FulfillmentPlan'),customs=last('CustomsAssessment'),quote=last('LandedCostQuote');
    let next:AgentDecision;
    if(!context || !directory)next=decision(ctx,[...(!context?[step('ReadCommerceContext',{scope})]:[]),...(!directory?[step('SearchCommerceMerchants',{scope,query:'coffee'})]:[])]);
    else if(!product)next=decision(ctx,[step('ReadCommerceProduct',{scope,discovery:directory.ref,merchantId:'harbor-cn',query:'coffee'})]);
    else if(!inventory)next=decision(ctx,[step('ReadCommerceInventory',{scope,product:product.ref,quantity:2})]);
    else if(!route)next=decision(ctx,[step('ReadCommerceFulfillment',{scope,product:product.ref,inventory:inventory.ref,context:context.ref,addressId:context.value.addresses[0].id,quantity:2})]);
    else if(!customs)next=decision(ctx,[step('ReadCommerceCustoms',{scope,product:product.ref,fulfillment:route.ref,optionId:route.value.options[0].id})]);
    else if(!quote)next=decision(ctx,[step('QuoteCommerceLandedCost',{scope,product:product.ref,inventory:inventory!.ref,fulfillment:route.ref,customs:customs.ref,optionId:route.value.options[0].id})]);
    else next=decision(ctx,[],{selected:quote.ref,rationale:'Independent synthetic quotation without purchase'});
    commercePolicyReads(access,next);return next;
  },base);
  try {
    const job=f.tasks.submit(f.p,{service:'eigos.delegate',requestId:randomUUID(),goal:'Quote two bags of coffee in the isolated sandbox',executionEnvironment:'sandbox'}),done=await f.advance(job.id,20);
    assert.equal(done.state,'completed',JSON.stringify(done.delegation?.agent?.feedback));const view=JSON.stringify(f.tasks.get(f.p,job.id));assert.ok(view.includes('buyerTotal'));assert.ok(!view.includes('extendedAddress'));assert.ok(!f.modelInputs.join('\n').includes('"street":'));assert.ok(provider.audit().every(a=>['Read','Search','Quote'].some(prefix=>String(a.action).startsWith(prefix))));
  }finally{f.close();await provider.close();}
});
