import test from 'node:test';
import assert from 'node:assert/strict';
import {securityGatewayFixture} from './fixtures/security-gateway.js';
import {didiFixture} from './fixtures/didi.js';
import {DidiAgentProgram} from '../packages/capabilities/didi/program.js';
import {ExecutionCatalog} from '../packages/core/catalog.js';
import {ownerKey} from '../packages/core/domain.js';
import {randomUUID} from 'node:crypto';
import {customerPermissionOverview,permissionsPage,preparePermissionReview} from '../apps/gateway/members/permissions-page.js';

async function fixture() {
  const source=didiFixture(),f=await securityGatewayFixture((_store,p)=>{
    class Program extends DidiAgentProgram {override permitted(owner:string){return owner===ownerKey(p);}}
    const program=new Program(source.binding,{connector:source.connector});return new ExecutionCatalog([program.capability()],[],[],[],[program]);
  });
  const a=f.install(),b=f.install(),profile=f.gateway.security!.sourceProfiles(f.member.id).profiles[0]!,now=Date.now();
  for(const [actor,type,field,operation,channels,hours] of [
    [a,'DidiPlaceObservation','displayTitle','SearchDidiPlaces',['agent_response'],1],
    [b,'RideEstimateObservation','observedData','EstimateDidiRide',['agent_response','registered_model'],2],
  ] as const) {
    const expiresAt=new Date(now+hours*3600000).toISOString();
    f.gateway.security!.approveAgentGrant(f.member.id,{installationId:actor.id,capabilityIds:[profile.programId],resources:[{type:'ServiceRequest',fields:['requestId','originalGoal']},{type,fields:[field]}],sourceBindingIds:[profile.bindingId],channels:[...channels],expiresAt});
    f.qualify(actor.id);
    f.gateway.security!.approveSource(f.member.id,{installationId:actor.id,bindingId:profile.bindingId,programId:profile.programId,operations:[operation],outputTypes:[type],expiresAt,expectedRevision:f.gateway.store.security.policies.revision(),expectedAgentGrant:{id:f.gateway.store.security.agentGrant(actor.id).id,revision:1}});
  }
  return {...f,a,b,now,profile,source,close:async()=>{await f.close();source.close();}};
}

test('customer permissions keep each connection action, data, purpose and expiry separate',async()=>{
  const f=await fixture();try {
    const view=f.gateway.security!.managementView(f.member.id),html=customerPermissionOverview(view,f.member,f.session.csrf,f.now);
    const cards=[...html.matchAll(/<article class="permission-range">([\s\S]*?)<\/article>/g)].map(match=>match[1]!);
    assert.equal(cards.length,2);
    const places=cards.find(card=>card.includes('查询出发地和目的地'))!,estimates=cards.find(card=>card.includes('查询车型与预估价'))!;
    assert(places);assert(estimates);
    assert(!places.includes('查询车型与预估价'));assert(places.includes('地点查询结果'));assert(!places.includes('车型与预估价'));
    assert(!places.includes('允许符合要求的 AI 模型'));
    assert(!estimates.includes('查询出发地和目的地'));assert(estimates.includes('车型与预估价'));assert(estimates.includes('允许符合要求的 AI 模型'));
    for(const card of cards){assert(card.includes('有效至'));assert(card.includes('查看收回授权的影响'));}
    const page=permissionsPage(view,f.member,f.session.csrf),customer=page.slice(page.indexOf('aria-label="客户授权总览"'),page.indexOf('id="permission-technical"'));
    assert(customer.includes('你允许 EIGOS'));assert(!customer.includes('Synthetic Agent'));assert(!customer.includes('SearchDidiPlaces'));
    assert(page.includes('高级连接与权限明细'));assert(page.includes('Synthetic Agent'));
    const technicalDescriptions={...view,fields:view.fields.map(row=>({...row,fields:row.fields.map(field=>({...field,description:'INTERNAL_SCHEMA_DESCRIPTION'}))})),
      grants:view.grants.map(grant=>grant.kind==='agent_access'?{...grant,resources:grant.resources.map(row=>row.type==='DidiPlaceObservation'?{...row,fields:['id']}:row)}:grant)};
    const readable=customerPermissionOverview(technicalDescriptions,f.member,f.session.csrf,f.now);
    assert(readable.includes('记录标识'));assert(!readable.includes('INTERNAL_SCHEMA_DESCRIPTION'));
    const withExactFields=permissionsPage(technicalDescriptions,f.member,f.session.csrf);
    const advanced=withExactFields.slice(withExactFields.indexOf('id="permission-technical"'));
    assert(advanced.includes('原始授权记录与完整字段'));assert(advanced.includes('&quot;resources&quot;'));assert(advanced.includes('&quot;id&quot;'));
    assert.equal(f.source.calls.length,0);
  }finally{await f.close();}
});

test('expired, revoked or ceiling-only records are never described as enabled service permissions',async()=>{
  const f=await fixture();try {
    const view=f.gateway.security!.managementView(f.member.id);
    assert(!customerPermissionOverview(view,f.member,f.session.csrf,f.now+3*3600000).includes('class="permission-range"'));
    const blocked={...view,installations:view.installations.map(item=>({...item,revoked:true}))};
    assert(!customerPermissionOverview(blocked,f.member,f.session.csrf,f.now).includes('class="permission-range"'));
    const withoutSource={...view,sources:[]};
    const html=customerPermissionOverview(withoutSource,f.member,f.session.csrf,f.now);
    assert(html.includes('当前没有已授权的服务范围'));assert(html.includes('可申请使用的范围上限'));
    assert(!html.includes('class="permission-range"'));
    const noFields={...view,grants:view.grants.map(grant=>grant.kind==='agent_access'?{...grant,resources:grant.resources.filter(row=>row.type==='ServiceRequest')}:grant)};
    assert(!customerPermissionOverview(noFields,f.member,f.session.csrf,f.now).includes('class="permission-range"'));
  }finally{await f.close();}
});

test('task scopes include older granted tasks, escape titles and stop describing changed request versions as current',async t=>{
  const f=await fixture();try {
    const title='查询公开地点 <script>private()</script>';
    const submitted=await f.post('/tasks',{service:'eigos.delegate',requestId:randomUUID(),goal:title},{authorization:`Bearer ${f.a.token}`});
    assert.equal(submitted.status,200);
    const list=f.gateway.store.list.bind(f.gateway.store);
    t.mock.method(f.gateway.store,'list',(...[owner,filter,taskIds]:Parameters<typeof list>)=>taskIds?list(owner,filter,taskIds):{jobs:[],total:51});
    const view=f.gateway.security!.managementView(f.member.id);
    assert(view.tasks.some(task=>task.title===title),'A task grant must not disappear outside the latest task page');
    const html=customerPermissionOverview(view,f.member,f.session.csrf,f.now);
    assert(html.includes('查询公开地点 &lt;script&gt;private()&lt;/script&gt;'));
    assert(!html.includes('<script>private()'));
    assert(html.includes('仅限这项任务，不适用于其他任务'));
    assert(html.includes('查询任务进度'));
    const changed={...view,tasks:view.tasks.map(task=>({...task,requestRevision:task.requestRevision+1}))};
    assert(!customerPermissionOverview(changed,f.member,f.session.csrf,f.now).includes('仅限这项任务，不适用于其他任务'));
    const updated={...view,profiles:view.profiles.map(profile=>({...profile,programDigest:'0'.repeat(64)}))};
    const stale=customerPermissionOverview(updated,f.member,f.session.csrf,f.now);
    assert(stale.includes('服务已更新'));assert(stale.includes('使用新版前需要重新确认范围'));
    assert.equal(f.source.calls.length,0);
  }finally{await f.close();}
});

test('permission replacement preserves an exact existing deadline without copying rights or borrowing another connection deadline',async()=>{
  const f=await fixture();try {
    const manager=f.gateway.security!,view=manager.managementView(f.member.id);
    const prior=view.grants.find(g=>g.kind==='agent_access' && g.installationId===f.a.id)!;
    const foreign=view.grants.find(g=>g.kind==='agent_access' && g.installationId===f.b.id)!;
    const form={kind:'agent',installationId:f.a.id,programs:f.profile.programId,fields:'ServiceRequest.requestId',channels:'agent_response',hours:'24',expiryGrantId:prior.id};
    const review=preparePermissionReview(view,form,f.now);
    assert.equal(review.input.expiresAt,prior.expiresAt);
    assert.deepEqual(review.input.resources,[{type:'ServiceRequest',fields:['requestId']}]);
    assert.deepEqual(review.input.channels,['agent_response']);
    assert.throws(()=>preparePermissionReview(view,{...form,expiryGrantId:foreign.id},f.now),/this installation/);
    assert.throws(()=>preparePermissionReview(view,{...form,expiryGrantId:randomUUID()},f.now),/this installation/);
    assert.throws(()=>preparePermissionReview(view,form,Date.parse(prior.expiresAt)),/unexpired/);
    assert.throws(()=>preparePermissionReview(view,{...form,kind:'task'},f.now),/Only installation and source/);
    manager.revokeGrant(f.member.id,prior.id,prior.revision);
    const replaced=manager.managementView(f.member.id);
    assert.equal(replaced.grants.find(g=>g.id===prior.id)!.status,'revoked');
    const input=preparePermissionReview(replaced,form,f.now).input;
    const parent=manager.approveAgentGrant(f.member.id,input);
    assert.equal(parent.expiresAt,prior.expiresAt);
    const sourceForm={kind:'source',installationId:f.a.id,programId:f.profile.programId,operations:'SearchDidiPlaces',outputTypes:'DidiPlaceObservation',expiryGrantId:prior.id,hours:'1'};
    const current=manager.managementView(f.member.id);
    assert.equal(preparePermissionReview(current,sourceForm,f.now).input.expiresAt,prior.expiresAt);
    const shorter=new Date(Date.parse(parent.expiresAt)-1000).toISOString();
    const clipped={...current,grants:current.grants.map(g=>g.id===parent.id?{...g,expiresAt:shorter}:g)};
    assert.equal(preparePermissionReview(clipped,sourceForm,f.now).input.expiresAt,shorter);
    assert(permissionsPage(current,f.member,f.session.csrf).includes('name="expiryGrantId"'));
    assert.equal(f.source.calls.length,0);
  }finally{await f.close();}
});
