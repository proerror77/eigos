import {z} from 'zod';
import {memberLayout} from './page.js';
import type {AuthorizationCoordinator} from '../../../packages/security/coordinator.js';
import type {Member} from '../../../packages/members/store.js';

type View=ReturnType<AuthorizationCoordinator['managementView']>;
export type PermissionReview={kind:'agent'|'source'|'task'|'revoke'|'revoke_source'|'recovery';input:Record<string,unknown>;policyRevision:number};
const escape=(v:unknown)=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!);
const channels:Record<string,string>={agent_response:'把结果返回给这个助手',registered_model:'交给已登记、符合数据要求的模型处理',controlled_download:'通过受控入口下载文件',member_ui:'会员页面'};
const values=(v:unknown)=>v===undefined?[]:z.array(z.string().max(2000)).max(1000).parse(Array.isArray(v)?v:[v]);
const options=(view:View)=>view.installations.filter(a=>!a.revoked).map(a=>`<option value="${escape(a.id)}">${escape(a.name)} · ${escape(a.id.slice(0,8))}</option>`).join('');
const check=(name:string,value:string,label:string)=>`<label class="check"><input type="checkbox" name="${name}" value="${escape(value)}"><span>${label}</span></label>`;
const hidden=(name:string,value:unknown)=>`<input type="hidden" name="${name}" value="${escape(value)}">`;
const expiry=(member:Member,value:unknown)=>new Intl.DateTimeFormat(member.locale,{timeZone:member.timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(String(value)));

export function preparePermissionReview(view:View,form:Record<string,unknown>,now=Date.now()):PermissionReview {
  const kind=z.enum(['agent','source','task','revoke','revoke_source','recovery']).parse(form.kind),installationId=z.uuid().parse(form.installationId);
  if(!view.installations.some(a=>a.id===installationId && !a.revoked)) throw new Error('Unknown installation');
  const hours=z.coerce.number().int().min(1).max(kind==='agent'?720:24).parse(form.hours??1),expiresAt=new Date(now+hours*3600000).toISOString();
  const selectedChannels=values(form.channels);if(!selectedChannels.every(c=>Object.hasOwn(channels,c)))throw new Error('Unknown channel');
  let input:Record<string,unknown>;
  if(kind==='agent') {
    const capabilityIds=values(form.programs),selected=values(form.fields);
    if(!capabilityIds.length || !capabilityIds.every(id=>view.profiles.some(p=>p.programId===id)))throw new Error('Choose an available capability');
    const resources=view.fields.map(r=>({type:r.type,fields:r.fields.filter(f=>selected.includes(`${r.type}.${f.field}`)).map(f=>f.field)})).filter(r=>r.fields.length);
    if(resources.flatMap(r=>r.fields).length!==selected.length || !selectedChannels.length)throw new Error('Choose registered fields and channels');
    input={installationId,capabilityIds,resources,sourceBindingIds:view.profiles.filter(p=>capabilityIds.includes(p.programId)).map(p=>p.bindingId),channels:selectedChannels,expiresAt};
  } else if(kind==='source') {
    const profile=view.profiles.find(p=>p.programId===form.programId),parent=view.grants.find(g=>g.kind==='agent_access' && g.installationId===installationId && g.status==='active');
    if(!profile || !parent)throw new Error('Approve the installation ceiling first');
    const operations=values(form.operations),outputTypes=values(form.outputTypes);
    if(!operations.length || !outputTypes.length || !operations.every(o=>profile.operations.includes(o)) || !outputTypes.every(t=>profile.outputTypes.includes(t)))throw new Error('Choose available source operations and outputs');
    input={installationId,bindingId:profile.bindingId,programId:profile.programId,operations,outputTypes,expiresAt:new Date(Math.min(Date.parse(expiresAt),Date.parse(parent.expiresAt))).toISOString(),expectedRevision:view.policyRevision,expectedAgentGrant:{id:parent.id,revision:parent.revision}};
  } else if(kind==='task') {
    const task=view.tasks.find(t=>t.id===form.taskId),parent=view.grants.find(g=>g.kind==='agent_access' && g.installationId===installationId && g.status==='active');
    if(!task || !parent)throw new Error('Choose an owned task and active installation ceiling');
    const selected=values(form.inputs),inputs=view.objects.map(o=>({...o,fields:o.fields.filter(field=>selected.includes(JSON.stringify([o.object,o.objectRevision,field])))})).filter(o=>o.fields.length)
      .map(({object,objectRevision,fields})=>({object,objectRevision,fields}));
    if(inputs.flatMap(i=>i.fields).length!==selected.length)throw new Error('Selected object revision or field is no longer available');
    const programIds=values(form.programs);if(!programIds.every(id=>view.sources.some(s=>s.installationId===installationId && s.programId===id)))throw new Error('Approve the selected source first');
    const current=view.grants.find(g=>g.kind==='task_data' && g.installationId===installationId && g.taskId===task.id && g.status==='active');
    const takeover=form.takeover==='yes';
    input={installationId,taskId:task.id,expectedRequestRevision:task.requestRevision,expectedAgentGrant:{id:parent.id,revision:parent.revision},...(current?{replaces:{id:current.id,revision:current.revision}}:{}),takeover,
      inputs,programIds,purpose:'delegated_task',operations:['task.query','task.result.read',...(takeover?['task.process']:[]),...(inputs.length?['member_asset.read']:[]),...(selectedChannels.includes('controlled_download')?['artifact.export']:[])],
      channels:selectedChannels,expiresAt:new Date(Math.min(Date.parse(expiresAt),Date.parse(parent.expiresAt))).toISOString()};
    if(!selectedChannels.length)throw new Error('Choose a delivery channel');
  } else if(kind==='recovery') {
    const operation=view.recoveryCandidates.find(o=>o.intentId===form.intentId);
    const source=operation?view.sources.find(s=>s.installationId===installationId && s.programId===operation.programId && s.operations.includes('recover_original')):undefined;
    const parent=view.grants.find(g=>g.kind==='agent_access' && g.installationId===installationId && g.status==='active');
    if(!operation || !source || !parent)throw new Error('No eligible original-operation observer');
    input={installationId,intentId:operation.intentId,expectedIntentDigest:operation.expectedIntentDigest,expiresAt:new Date(Math.min(now+3600000,Date.parse(source.expiresAt),Date.parse(parent.expiresAt))).toISOString()};
  } else if(kind==='revoke_source') {
    const source=view.sources.find(s=>s.installationId===installationId && s.bindingId===form.bindingId);
    if(!source)throw new Error('Source authorization is no longer active');
    input={installationId,bindingId:source.bindingId,expectedRevision:view.policyRevision};
  } else {
    const grant=view.grants.find(g=>g.id===form.grantId && g.installationId===installationId && g.status==='active');if(!grant)throw new Error('Grant is no longer active');
    input={grantId:grant.id,expectedRevision:grant.revision,installationId};
  }
  return {kind,input,policyRevision:view.policyRevision};
}

export function permissionsPage(view:View,member:Member,csrf:string,notice?:string) {
  const form=(kind:string,body:string)=>`<form method="post" action="/members/permissions/review">${hidden('_csrf',csrf)}${hidden('kind',kind)}${body}<button type="submit">${kind.startsWith('revoke')?'审阅撤销范围':'查看本次授权范围'}</button></form>`;
  const install=`<label>个人助手<select name="installationId" required>${options(view)}</select></label>`;
  const channelChoices=Object.entries(channels).filter(([key])=>key!=='member_ui').map(([key,label])=>check('channels',key,escape(label))).join('');
  const active=view.grants.filter(g=>g.status==='active' && Date.parse(g.expiresAt)>Date.now());
  const current=active.length?active.map(g=>`<article><h3>${escape(view.installations.find(a=>a.id===g.installationId)?.name??'助手')} · ${g.kind==='agent_access'?'安装授权上限':'任务授权'}</h3>
    <p>${g.kind==='task_data'?`任务 <code>${escape(g.taskId)}</code> · 请求版本 ${g.requestRevision}`:`${g.capabilityIds.length} 项能力 · ${g.resources.length} 类数据`}</p>
    <p>${g.channels.map(c=>escape(channels[c])).join(' · ')}<br>到期：${escape(expiry(member,g.expiresAt))}</p>
    ${form('revoke',hidden('installationId',g.installationId)+hidden('grantId',g.id))}</article>`).join(''):'<p class="muted">还没有有效的数据授权。</p>';
  const sourceGrants=view.sources.map(s=>`<article><h3>${escape(view.installations.find(a=>a.id===s.installationId)?.name??'助手')} · 来源许可</h3><p>${escape(view.profiles.find(p=>p.programId===s.programId)?.name??s.programId)}</p><p>操作：${s.operations.map(escape).join('、')}<br>输出：${s.outputTypes.map(t=>escape(view.fields.find(f=>f.type===t)?.name??t)).join('、')}<br>到期：${escape(expiry(member,s.expiresAt))}</p>${form('revoke_source',hidden('installationId',s.installationId)+hidden('bindingId',s.bindingId))}</article>`).join('');
  const ceilings=view.profiles.length && options(view)?form('agent',install+`<fieldset><legend>允许创建的任务能力</legend>${view.profiles.map(p=>check('programs',p.programId,escape(p.name))).join('')}</fieldset>
    <fieldset><legend>可使用的数据字段</legend><p class="fine">结构化字段涵盖其完整子项；未勾选的字段不在授权内。</p>${view.fields.map(r=>`<details><summary>${escape(r.name)}</summary>${r.fields.map(f=>check('fields',`${r.type}.${f.field}`,`${escape(f.description)}${f.sensitive?' · 敏感数据':''}<small><code>${escape(r.type)}.${escape(f.field)}</code></small>`)).join('')}</details>`).join('')}</fieldset>
    <fieldset><legend>允许的处理和交付渠道</legend>${channelChoices}</fieldset><label>有效期<select name="hours"><option value="24">1 天</option><option value="168">7 天</option><option value="720">30 天</option></select></label>`):'<div class="empty">当前没有可授予的已绑定来源能力。来源必须先通过已有账号与连接资格检查。</div>';
  const sourceForms=view.profiles.map(profile=>`<details><summary>${escape(profile.name)}</summary>${form('source',install+hidden('programId',profile.programId)+`<fieldset><legend>来源操作</legend>${profile.operations.map(o=>check('operations',o,escape(o==='recover_original'?'仅查询原操作的状态':o))).join('')}</fieldset><fieldset><legend>允许接收的数据类型</legend>${profile.outputTypes.map(t=>check('outputTypes',t,escape(view.fields.find(f=>f.type===t)?.name??t))).join('')}</fieldset><label>有效期<select name="hours"><option value="1">1 小时</option><option value="8">8 小时</option><option value="24">24 小时</option></select></label>`)}</details>`).join('');
  const taskForm=view.tasks.length && active.length?form('task',install+`<label>任务<select name="taskId">${view.tasks.filter(t=>t.requestRevision>0).map(t=>`<option value="${escape(t.id)}">${escape(t.id.slice(0,8))} · ${escape(t.state)} · 版本 ${t.requestRevision}</option>`).join('')}</select></label>
    <fieldset><legend>选定的现有输入</legend><p class="fine">只显示本人拥有、已开放定义且可委托的当前对象。每个选择固定对象版本与字段。</p>${view.objects.map(o=>`<details><summary>${escape(o.title)} · ${escape(o.object.type)}</summary><small><code>${escape(o.object.id)}</code> · 版本 ${o.objectRevision}</small>${o.fields.map(field=>check('inputs',JSON.stringify([o.object,o.objectRevision,field]),escape(field))).join('')}</details>`).join('')||'<p>暂无可选择的现有对象。</p>'}</fieldset>
    <fieldset><legend>本任务可接收的来源输出</legend>${view.profiles.map(p=>check('programs',p.programId,escape(p.name))).join('')}</fieldset>
    <fieldset><legend>处理和交付</legend>${channelChoices}${check('takeover','yes','允许这个助手继续处理任务；会撤销其他助手对此任务的授权。已发出的业务操作须先完成原操作查证。')}</fieldset>
    <label>有效期<select name="hours"><option value="1">1 小时</option><option value="8">8 小时</option><option value="24">24 小时</option></select></label>`):'<p class="muted">有了安装授权和任务后，可以在这里批准输入、来源和接管范围。</p>';
  const recovery=view.recoveryCandidates.length && view.sources.some(s=>s.operations.includes('recover_original'))?form('recovery',install+`<label>原操作<select name="intentId">${view.recoveryCandidates.map(o=>`<option value="${escape(o.intentId)}">${escape(o.action)} · ${escape(o.taskId.slice(0,8))}</option>`).join('')}</select></label><p>仅回读原操作；最多三次、一小时内有效。结果进入审计记录。</p>`):'<p class="muted">当前没有具备专用只读观察器的待查证操作。</p>';
  return memberLayout(`<section><p class="eyebrow">权限管理</p><h1>由你批准<br>每一层范围。</h1><p>安装上限决定助手可以申请什么。来源许可和任务授权再确定具体用途、数据与期限。平台的数据资格和资源权限仍须满足。</p><h2>当前授权</h2>${current}${sourceGrants}<details><summary>新增安装授权上限</summary>${ceilings}</details><details><summary>批准来源操作</summary>${sourceForms||'<p>暂无可用来源。</p>'}</details></section><aside><h2>任务范围与接管</h2>${taskForm}<details><summary>原操作查证</summary>${recovery}${view.recoveries.map(r=>`<p><code>${escape(r.intentId.slice(0,8))}</code> · ${escape(r.state)} · 已读 ${r.attempts} 次</p>`).join('')}</details><p><a href="/members">返回会员中心</a></p></aside>`,notice,'数据与任务授权');
}

export function permissionReviewPage(review:PermissionReview,view:View,member:Member,csrf:string,id:string) {
  const input=review.input,install=view.installations.find(a=>a.id===input.installationId);
  const revoking=review.kind.startsWith('revoke');
  const title=review.kind==='revoke_source'?'撤销这个来源的许可':review.kind==='revoke'?'撤销这份授权':review.kind==='recovery'?'批准原操作查证':review.kind==='task'?'批准任务范围':review.kind==='source'?'批准来源操作':'批准安装授权上限';
  const rows:{label:string;value:unknown}[]=[];
  if(review.kind==='agent') rows.push({label:'能力',value:(input.capabilityIds as string[]).map(id=>view.profiles.find(p=>p.programId===id)?.name??id).join('、')},{label:'来源',value:(input.sourceBindingIds as string[]).join('、')});
  if(review.kind==='source') rows.push({label:'来源',value:view.profiles.find(p=>p.programId===input.programId)?.name??input.programId},{label:'操作',value:(input.operations as string[]).join('、')},{label:'输出类型',value:(input.outputTypes as string[]).join('、')});
  if(review.kind==='revoke_source') {
    for(const source of view.sources.filter(s=>s.installationId===input.installationId && s.bindingId===input.bindingId))rows.push({label:'撤销来源',value:view.profiles.find(p=>p.programId===source.programId)?.name??source.programId},{label:'撤销操作',value:source.operations.join('、')},{label:'撤销输出',value:source.outputTypes.map(t=>view.fields.find(f=>f.type===t)?.name??t).join('、')});
    rows.push({label:'影响',value:'停止此助手对该来源的新调用，并撤销依赖该来源输出的任务授权。已发生的操作与审计证据保留。'});
  }
  if(review.kind==='task') rows.push({label:'任务',value:input.taskId},{label:'固定请求版本',value:input.expectedRequestRevision},{label:'接管处理',value:input.takeover?'是；撤销本任务其他助手的旧授权':'否；仅批准数据访问'});
  if(review.kind==='recovery'){const operation=view.recoveryCandidates.find(o=>o.intentId===input.intentId);rows.push({label:'原任务',value:operation?.taskId},{label:'原操作',value:operation?.action},{label:'范围',value:'只读取原操作状态，最多三次。不执行模型、普通数据查询、任务投影或新业务派发。'});}
  return memberLayout(`<section><p class="eyebrow">确认范围</p><h1>${title}</h1><p>个人助手：<strong>${escape(install?.name??input.installationId)}</strong></p>
    ${rows.map(r=>`<p><strong>${escape(r.label)}</strong><br>${escape(r.value)}</p>`).join('')}
    ${input.expiresAt?`<p><strong>到期时间</strong><br>${escape(expiry(member,input.expiresAt))}（${escape(member.timezone)}）</p>`:''}
    ${input.channels?`<p><strong>处理和交付渠道</strong><br>${(input.channels as string[]).map(c=>escape(channels[c])).join('<br>')}</p>`:''}
    ${input.resources?`<h2>完整字段上限</h2>${(input.resources as {type:string;fields:string[]}[]).map(r=>`<details open><summary>${escape(view.fields.find(f=>f.type===r.type)?.name??r.type)}</summary><p>${r.fields.map(escape).join('、')}</p></details>`).join('')}`:''}
    ${input.inputs?`<h2>固定现有输入</h2>${(input.inputs as {object:{type:string;id:string};objectRevision:number;fields:string[]}[]).map(r=>`<details open><summary>${escape(r.object.type)} · 版本 ${r.objectRevision}</summary><code>${escape(r.object.id)}</code><p>${r.fields.map(escape).join('、')}</p></details>`).join('')||'<p>没有额外的现有资产输入。</p>'}`:''}
    ${review.kind==='task'?(()=>{const parent=view.grants.find(g=>g.kind==='agent_access' && g.installationId===input.installationId && g.status==='active');return `<h2>本任务的提交内容</h2><p>${parent?.kind==='agent_access'?parent.resources.find(r=>r.type==='ServiceRequest')?.fields.map(escape).join('、')??'没有可读的提交字段':''}</p>`;})():''}
    ${review.kind==='task'?`<h2>来源输出范围</h2>${(input.programIds as string[]).map(programId=>{const source=view.sources.find(s=>s.programId===programId && s.installationId===input.installationId);const parent=view.grants.find(g=>g.kind==='agent_access' && g.installationId===input.installationId && g.status==='active');return `<details open><summary>${escape(view.profiles.find(p=>p.programId===programId)?.name??programId)}</summary>${source?.outputTypes.map(type=>`<p>${escape(type)}：${parent?.kind==='agent_access'?parent.resources.find(r=>r.type===type)?.fields.map(escape).join('、')??'无可授予字段':''}</p>`).join('')??''}</details>`;}).join('')||'<p>没有新增来源输出规则。</p>'}`:''}
    ${review.kind==='revoke'?`<p>授权编号 <code>${escape(input.grantId)}</code>。撤销后旧游标、输出和任务执行授权均须重新检查。</p>`:''}
    <form method="post" action="/members/permissions/approve">${hidden('_csrf',csrf)}${hidden('reviewId',id)}<button class="primary" type="submit" name="confirm" value="approve">${revoking?'确认撤销':'批准以上范围'}</button></form><p><a href="/members/permissions">返回修改</a></p></section><aside><h2>${revoking?'本次撤销的边界':'本次批准的边界'}</h2><p>${revoking?'只撤销本页列出的范围及其依赖授权。':'只批准本页列出的范围。结构化字段包含其完整子项。'}</p><p>来源配置、对象版本或权限状态发生变化时，需要重新查看。购买、付款或对外发送仍需要具体业务许可。</p><p class="fine">此审阅页五分钟内有效。</p></aside>`,undefined,'审阅授权');
}
