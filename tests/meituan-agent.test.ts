import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setupMeituan, chooseMeituan, readMeituan } from './fixtures/meituan-agent.js';
import { digest } from '../packages/core/delegation.js';
import { owner, principal } from './backend-fixture.js';

test('Meituan initialization is pure; model selects book, human clarification, details and one quote', async () => {
  const t = setupMeituan();
  try {
    const job = t.b.submit({ goal: '查1公斤文件普通送价格，先让我选择地址', requirements: [{ id: 'weight', kind: 'quantity', strength: 'hard', expected: { amount: '1', unit: '公斤' } }] });
    await t.b.run(); assert.equal(t.calls.length, 0);
    const asked = await t.finish(job.id); assert.equal(asked.state, 'input-required'); assert.match(asked.question!, /地址1：测试住处/);
    assert.deepEqual(t.calls.map(c => c.tool), ['get_address_list']);
    t.b.tasks.reply(principal, { taskId: job.id, answer: '寄件用地址1，收件用地址2', requestId: 'select-addresses' });
    const done = await t.finish(job.id); assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback)); assert(done.delegation!.acceptance!.accepted);
    assert.equal(t.calls.filter(c => c.tool === 'delivery_preview').length, 1);
    assert.deepEqual(t.calls.slice(1).map(c => c.tool).sort(), ['delivery_preview', 'get_address_info', 'get_address_info', 'get_address_list'].sort());
    const result = done.artifact!.data.result as { quote: { _previewTotal: string } }; assert.equal(result.quote._previewTotal, '12.50');
    assert(!JSON.stringify(done.delegation!.agent).includes('13800001111'));
    assert(!JSON.stringify(done.delegation!.agent).includes('测试住处'));
    assert(!JSON.stringify(done.artifact).includes('13800001111'));
    assert(!JSON.stringify(done.delegation!.agent).includes(digest('synthetic-meituan-account')));
    assert(t.store.intents(owner, job.id).every(i => i.effect === 'read'));
  } finally { t.close(); }
});

test('Current private address choices and contacts never enter model input or ontology observations', async () => {
  const t = setupMeituan('delivery', (ctx, access) => {
    assert(!JSON.stringify(ctx).includes('private-a')); assert(!JSON.stringify(ctx).includes('测试住处')); assert(!JSON.stringify(ctx).includes('13800001111'));
    const observations = readMeituan(ctx, access); assert(!JSON.stringify(observations).includes('private-a')); assert(!JSON.stringify(observations).includes('测试住处')); assert(!JSON.stringify(observations).includes('13800001111'));
    return chooseMeituan(ctx, access);
  });
  try { const job = t.b.submit({ goal: '只查询运费，先选择地址' }); const asked = await t.finish(job.id); assert.equal(asked.state, 'input-required'); assert.match(asked.question!, /测试住处/); } finally { t.close(); }
});

test('A public-location goal cannot read private addresses and has no eager discovery query', async () => {
  const t = setupMeituan('geo');
  try {
    const job = t.b.submit({ goal: '只查北京天安门公开地点' }); await t.b.run(); assert.equal(t.calls.length, 0);
    const done = await t.finish(job.id); assert.equal(done.state, 'completed'); assert.deepEqual(t.calls.map(c => c.tool), ['search_poi']);
    assert.throws(() => t.catalog.agentProgram({ id: 'geo.search', version: '1' }, owner)!.schema('ReadMeituanAddresses'));
  } finally { t.close(); }
});

test('Same-city checks reject a cross-city pair before any contact or quote read', async () => {
  const t = setupMeituan('delivery', chooseMeituan, { sender: '地址1', recipient: '地址3' });
  try {
    const job = t.b.submit({ goal: '只查价，先选择地址' }); await t.finish(job.id);
    t.b.tasks.reply(principal, { taskId: job.id, answer: '寄件用地址1，收件用地址3', requestId: 'cross-city' });
    const asked = await t.finish(job.id); assert.equal(asked.state, 'input-required'); assert.match(asked.question!, /同城/);
    assert(t.calls.every(c => c.tool === 'get_address_list'));
  } finally { t.close(); }
});

test('Reordered source addresses retain the actual published choice identities', async () => {
  const t=setupMeituan();
  try {
    const job=t.b.submit({goal:'只查运费，先选择地址'});await t.finish(job.id);t.setBook([...t.getBook()].reverse());
    t.b.tasks.reply(principal,{taskId:job.id,answer:'寄件地址1到收件地址2',requestId:'reordered'});
    assert.equal((await t.finish(job.id)).state,'completed');
    assert.deepEqual(t.calls.filter(c=>c.tool==='get_address_info').map(c=>c.input.address_id).sort(),['private-a','private-b']);
  }finally{t.close();}
});

test('Changed address content invalidates old labels before reading contacts or quoting',async()=>{
  const t=setupMeituan();
  try{
    const job=t.b.submit({goal:'只查价，先选地址'});await t.finish(job.id);
    t.setBook(t.getBook().map(a=>a.addressId==='private-a'?{...a,address:'已修改的合成住处'}:a));
    t.b.tasks.reply(principal,{taskId:job.id,answer:'寄件地址1到收件地址2',requestId:'changed-address'});
    const asked=await t.finish(job.id);assert.equal(asked.state,'input-required');assert.match(asked.question!,/地址簿已变化/);
    assert(t.calls.every(c=>c.tool==='get_address_list'));
  }finally{t.close();}
});

test('A claimed evaluation without a recorded model read cannot authorize contact queries',async()=>{
  let suppress=false;
  const t=setupMeituan('delivery',(ctx,access)=>{
    if(suppress){const call=access.session.call.bind(access.session);access.session.call=(tool,args)=>tool==='evaluate_ontology'?{status:'known'}:call(tool,args);}
    return chooseMeituan(ctx,access);
  });
  try{
    const job=t.b.submit({goal:'只查价，先选地址'});await t.finish(job.id);suppress=true;
    t.b.tasks.reply(principal,{taskId:job.id,answer:'寄件地址1到收件地址2',requestId:'no-evaluation'});
    const done=await t.finish(job.id);assert.notEqual(done.state,'completed');assert(t.calls.every(c=>c.tool==='get_address_list'));
  }finally{t.close();}
});

test('Cancellation fences late private cache writes as well as ontology projection',async()=>{
  const t=setupMeituan();let release!:()=>void,started!:()=>void,privateWrites=0;
  const save=t.store.savePreparationContext.bind(t.store);t.store.savePreparationContext=(owner,id,key,value)=>{privateWrites++;save(owner,id,key,value);};
  const ready=new Promise<void>(r=>{started=r;}),hold=new Promise<void>(r=>{release=r;});
  try{
    const job=t.b.submit({goal:'只查价'});await t.b.run();t.setBefore(async()=>{started();await hold;});
    const pending=t.b.run();await ready;t.b.tasks.cancel(principal,job.id);release();await pending;
    assert.equal(t.store.get(owner,job.id).state,'canceled');
    assert.equal(t.store.ontology.query(owner,{type:'MeituanReadObservation'}).items.length,0);
    assert.equal(privateWrites,0);
    assert.deepEqual(t.calls.map(c=>c.tool),['get_address_list']);
  }finally{release?.();t.close();}
});

test('Credential-context changes cannot mix an old book with newly authorized contact reads',async()=>{
  const t=setupMeituan();let books=0;
  try{
    const job=t.b.submit({goal:'只查价，先选地址'});await t.finish(job.id);
    t.setBefore(async tool=>{if(tool==='get_address_list'&&++books===1)t.setAccount('different-synthetic-account');});
    t.b.tasks.reply(principal,{taskId:job.id,answer:'寄件地址1到收件地址2',requestId:'changed-account'});
    const done=await t.finish(job.id);assert.notEqual(done.state,'completed');assert(t.calls.every(c=>c.tool==='get_address_list'));
  }finally{t.close();}
});

test('Unpublished options cannot be authorized by guessing numeric labels after a generic pause',async()=>{
  const t=setupMeituan('delivery',(ctx,access)=>{
    const observations=readMeituan(ctx,access),book=observations.find(o=>o.snapshot.data.kind==='addresses');
    if(ctx.request.revision===1&&book)return{kind:'execute',requestRevision:1,message:'Synthetic invalid decision',steps:[{id:'premature',action:'ReadMeituanSenderDetails',argumentsJson:JSON.stringify({scope:ctx.state.scope,addresses:book.ref}),dependsOn:[],inputRefs:[]}],completionJson:''};
    return chooseMeituan(ctx,access);
  });
  try{
    const job=t.b.submit({goal:'只查价，先选地址'});const paused=await t.finish(job.id);assert.equal(paused.state,'input-required');assert(!paused.question!.includes('本人保存地址：'));
    t.b.tasks.reply(principal,{taskId:job.id,answer:'寄件地址1到收件地址2',requestId:'guessed-unpublished-options'});
    const asked=await t.finish(job.id);assert.equal(asked.state,'input-required');assert.match(asked.question!,/本人保存地址：/);assert(t.calls.every(c=>c.tool==='get_address_list'));
  }finally{t.close();}
});

test('A private source from another owned task cannot authorize contact reads',async()=>{
  let foreign: {type:string;id:string}|undefined;
  const t=setupMeituan('delivery',(ctx,access)=>{
    const decision=chooseMeituan(ctx,access);
    if(foreign)for(const step of decision.steps)if(step.action==='ReadMeituanSenderDetails'||step.action==='ReadMeituanRecipientDetails')step.argumentsJson=JSON.stringify({...JSON.parse(step.argumentsJson),addresses:foreign});
    return decision;
  });
  try{
    const first=t.b.submit({goal:'只查价，先选地址'});await t.finish(first.id);
    foreign=t.store.get(owner,first.id).delegation!.agent!.observations[0]!;
    const second=t.b.submit({goal:'另一次只读查价，先选地址'});await t.finish(second.id);
    t.b.tasks.reply(principal,{taskId:second.id,answer:'寄件地址1到收件地址2',requestId:'cross-task-book'});
    const done=await t.finish(second.id);assert.notEqual(done.state,'completed');
    assert(t.calls.every(c=>c.tool==='get_address_list'));
  }finally{t.close();}
});

test('Later source coordinates invalidate an older quote even when address labels remain unchanged',async()=>{
  let books=0;
  const t=setupMeituan('delivery',(ctx,access)=>{
    const decision=chooseMeituan(ctx,access);
    if(decision.kind==='complete'&&ctx.state.observations.length===4)return{kind:'execute',requestRevision:ctx.request.revision,message:'Synthetic model explicitly refreshes the book after quoting',steps:[{id:'refresh',action:'ReadMeituanAddresses',argumentsJson:JSON.stringify({scope:ctx.state.scope}),dependsOn:[],inputRefs:[]}],completionJson:''};
    return decision;
  });
  try{
    const job=t.b.submit({goal:'只查价，先选地址'});await t.finish(job.id);
    t.setBefore(async tool=>{if(tool==='get_address_list'&&++books===2)t.setBook(t.getBook().map(a=>a.addressId==='private-a'?{...a,lat:31.5}:a));});
    t.b.tasks.reply(principal,{taskId:job.id,answer:'寄件地址1到收件地址2',requestId:'late-source-change'});
    const done=await t.finish(job.id);assert.notEqual(done.state,'completed');assert.equal(t.calls.filter(c=>c.tool==='delivery_preview').length,1);
    assert(done.delegation!.agent!.feedback.some(f=>f.message.includes('invalidated')));
  }finally{t.close();}
});
