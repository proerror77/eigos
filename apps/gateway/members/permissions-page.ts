import {z} from 'zod';
import {memberLayout} from './page.js';
import type {AuthorizationCoordinator} from '../../../packages/security/coordinator.js';
import type {Member} from '../../../packages/members/store.js';
import {taskContextFields} from '../../../packages/security/task-context-contract.js';

type View=ReturnType<AuthorizationCoordinator['managementView']>;
export type PermissionReview={kind:'agent'|'source'|'task'|'revoke'|'revoke_source'|'recovery';input:Record<string,unknown>;policyRevision:number};
const escape=(v:unknown)=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!);
const channels:Record<string,string>={agent_response:'把结果返回给这个助手',registered_model:'交给已登记、符合数据要求的模型处理',controlled_download:'通过受控入口下载文件',member_ui:'会员页面'};
const values=(v:unknown)=>v===undefined?[]:z.array(z.string().max(2000)).max(1000).parse(Array.isArray(v)?v:[v]);
const options=(view:View)=>view.installations.filter(a=>!a.revoked).map(a=>`<option value="${escape(a.id)}">${escape(a.name)} · ${escape(a.id.slice(0,8))}</option>`).join('');
const check=(name:string,value:string,label:string)=>`<label class="check"><input type="checkbox" name="${name}" value="${escape(value)}"><span>${label}</span></label>`;
const hidden=(name:string,value:unknown)=>`<input type="hidden" name="${name}" value="${escape(value)}">`;
const expiry=(member:Member,value:unknown)=>new Intl.DateTimeFormat(member.locale,{timeZone:member.timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(String(value)));

const serviceNames:Record<string,string>={
  'brief.prepare.atomic':'整理任务说明','document.compose':'生成文档','ride.estimate.query':'地点与出行估价',
  'geo.search':'查询公开地点','address.book.read':'读取已保存地址','delivery.quote':'同城配送估价',
  'services.compose.live':'组合处理多个服务','services.compose.sandbox':'组合处理多个服务',
  'booking.participant.free':'活动与预约','commerce.catalog.query':'查询与比较公开商品',
  'commerce.journey.sandbox':'交易与配送演练（测试服务）','ride.order.test':'叫车下单演练（测试服务）',
};
const operationNames:Record<string,string>={
  PrepareTaskBrief:'整理任务说明',ComposeDocument:'生成有来源的文档',SearchDidiPlaces:'查询出发地和目的地',EstimateDidiRide:'查询车型与预估价',
  SearchMeituanLocations:'查询公开地点',ReadMeituanAddresses:'读取已保存地址',ReadMeituanSenderDetails:'读取所选寄件地址',ReadMeituanRecipientDetails:'读取所选收件地址',EstimateMeituanDelivery:'查询配送预估价',
  InspectRegistrationPage:'查看活动与预约条件',ReadParticipantRegistration:'查询原报名或预约状态',
  SearchPublicCatalog:'搜索公开商品',InspectCatalogVariant:'查看商品规格',DiscoverMerchantCatalog:'查找商家商品目录',ReadMerchantVariants:'查询商家商品规格',
  ActivateServiceComponent:'衔接任务中的服务步骤',CompleteServiceComponent:'核验服务步骤的结果',recover_original:'查询已提交操作的状态',
  ReadCommerceContext:'读取这项交易的条件',SearchCommerceMerchants:'查找商家',ReadCommerceProduct:'查询商品',ReadCommerceInventory:'查询库存',ReadCommerceFulfillment:'查询配送方案',ReadCommerceCustoms:'查询海关要求',QuoteCommerceLandedCost:'查询预计总费用',ReadCommerceCart:'查询购物清单',ReadCommerceOrder:'查询订单状态',ReadCommercePayment:'查询付款状态',ReadCommerceDelivery:'查询配送状态',
};
const dataNames:Record<string,string>={
  ServiceRequest:'你提交的任务内容',RideEstimateTask:'出行查询条件',DidiPlaceObservation:'地点查询结果',RideEstimateObservation:'车型与预估价',RideRoute:'行程路线',
  Provider:'服务提供方信息',SourceReceipt:'服务结果的核验信息',BriefTask:'任务说明',TaskBrief:'整理后的任务说明',DocumentTask:'文档要求',DocumentDraft:'生成的文档',
  ServiceComposition:'任务步骤与依赖',ServiceComponent:'任务中的服务步骤',ServiceComponentResult:'步骤的核验结果',
  MeituanReadTask:'地点或配送查询条件',MeituanReadObservation:'地点、地址或配送查询结果',
  CommerceTask:'交易与配送条件',FulfillmentContext:'收货地区与配送条件',CommerceMerchantSearch:'商家搜索结果',CommerceProduct:'商品信息',InventoryObservation:'库存查询结果',InventoryReservation:'库存预留记录',FulfillmentPlan:'配送方案',CustomsAssessment:'海关与税费要求',LandedCostQuote:'预计总费用',Cart:'购物清单',CartLine:'清单中的商品',CommerceCheckout:'结账信息',CommerceOrderObservation:'订单状态',CommercePaymentObservation:'付款状态',CommerceDeliveryObservation:'配送状态',DeliveryPromise:'配送承诺',FulfillmentGroup:'配送分组',FactRequirement:'所需核验信息',Shipment:'配送批次',DeliveryEvent:'配送事件',DeliveryQuantityAllocation:'配送数量',Order:'订单记录',OrderLine:'订单商品',PaymentRecord:'付款记录',ProductVariant:'商品规格',
  CatalogQueryTask:'商品查询条件',CatalogObservation:'商品查询结果',MerchantCatalogEndpoint:'商家的商品目录',ProductOffer:'商品报价',ServiceChannel:'服务渠道',RegistrationTask:'报名与预约条件',RegistrationOffer:'活动或预约信息',RegistrationRecord:'原报名或预约状态',ParticipantBookingTask:'报名或预约要求',ParticipantBookingOffer:'活动与预约条件',ParticipantRegistration:'报名或预约状态',Parcel:'包裹资料',DeliveryRoute:'配送路线',ServiceQuote:'服务估价',
};
const fieldNames:Record<string,string>={originalGoal:'你提供的任务说明',conditions:'你设置的条件与限制',authorizedInput:'本任务已确定的查询条件',observedData:'查询结果与相关时间',addressBook:'已保存的地址（不含电话）',createdAt:'记录时间',progress:'任务进度',revision:'记录版本',requestId:'对应任务的标识',displayTitle:'记录名称',projectionState:'任务处理状态'};
const customerChannels:Record<string,string>={agent_response:'用于完成任务并向你返回结果',registered_model:'允许符合要求的 AI 模型处理这些资料',controlled_download:'允许通过受控入口下载结果',member_ui:'在你的 EIGOS 账号中查看'};
const taskOperationNames:Record<string,string>={'task.query':'查询任务进度','task.result.read':'读取任务结果','task.process':'继续处理这项任务','member_asset.read':'读取你选定的已有资料','artifact.export':'下载任务文件'};
const serviceName=(profile:View['profiles'][number])=>serviceNames[profile.programId]??profile.name;
const operationName=(view:View,id:string)=>operationNames[id]??view.operationDescriptions[id]??'服务中已选定的操作';
const dataName=(view:View,type:string)=>dataNames[type]??view.fields.find(field=>field.type===type)?.name??'已选择的业务资料';
const purposes=(items:readonly string[])=>items.map(channel=>`<li>${escape(customerChannels[channel]??'按该项授权的用途处理')}</li>`).join('');
const fieldName=(view:View,type:string,field:string)=>fieldNames[field]??view.fields.find(row=>row.type===type)?.fields.find(item=>item.field===field)?.description??'原授权中选定的字段';
function resourceSummary(view:View,rows:readonly {type:string;fields:string[]}[]) {
  if(!rows.length)return '<p class="muted">这项范围没有包含额外资料。</p>';
  const metadata=rows.filter(row=>row.type!=='ServiceRequest'&&Object.hasOwn(taskContextFields,row.type));
  const business=rows.filter(row=>!metadata.includes(row));
  return `<ul class="permission-data">${business.map(row=>`<li><strong>${escape(dataName(view,row.type))}</strong><small>${row.fields.map(field=>escape(fieldName(view,row.type,field))).join('、')}</small></li>`).join('')}${metadata.length?'<li><strong>任务处理记录</strong><small>仅原授权选定的任务上下文、步骤和核验记录；完整字段可在高级明细中查看。</small></li>':''}</ul>`;
}
function inputSummary(view:View,inputs:readonly {object:{type:string;id:string};objectRevision:number;fields:string[]}[]) {
  return inputs.length?`<ul class="permission-data">${inputs.map(input=>{
    const item=view.objects.find(item=>item.object.type===input.object.type&&item.object.id===input.object.id&&item.objectRevision===input.objectRevision);
    return `<li><strong>${escape(item?.title??dataName(view,input.object.type))}</strong><small>${input.fields.map(field=>escape(fieldName(view,input.object.type,field))).join('、')} · 仅限授权时选定的资料版本</small></li>`;
  }).join('')}</ul>`:'<p>没有额外的已有资料授权。</p>';
}

/** Presentation only: each source keeps its own installation/parent/fields.
 * Never form a broader permission by joining independent connections. */
export function customerPermissionOverview(view:View,member:Member,csrf:string,now=Date.now()) {
  const installations=new Set(view.installations.filter(installation=>!installation.revoked).map(installation=>installation.id));
  const active=view.grants.filter(grant=>installations.has(grant.installationId)&&grant.status==='active'&&Date.parse(grant.expiresAt)>now);
  const parents=active.filter(grant=>grant.kind==='agent_access');
  const revoke=(kind:'revoke'|'revoke_source',installationId:string,id:string)=>`<form method="post" action="/members/permissions/review">${hidden('_csrf',csrf)}${hidden('kind',kind)}${hidden('installationId',installationId)}${hidden(kind==='revoke'?'grantId':'bindingId',id)}<button type="submit">查看收回授权的影响</button></form>`;
  const resources=(rows:readonly {type:string;fields:string[]}[])=>resourceSummary(view,rows);
  const sources=view.sources.flatMap(source=>{
    const parent=parents.find(grant=>grant.installationId===source.installationId);
    const profile=view.profiles.find(item=>item.programId===source.programId&&item.bindingId===source.bindingId);
    if(!parent||parent.kind!=='agent_access'||!profile||Date.parse(source.expiresAt)<=now||!parent.sourceBindingIds.includes(source.bindingId)
      ||![profile.programId,profile.capabilityId].some(id=>parent.capabilityIds.includes(id)))return [];
    const rows=parent.resources.filter(row=>source.outputTypes.includes(row.type));
    if(!rows.length)return [];
    const until=new Date(Math.min(Date.parse(parent.expiresAt),Date.parse(source.expiresAt))).toISOString();
    return [{source,parent,profile,rows,until}];
  });
  const services=sources.map(({source,parent,profile,rows,until},index)=>`<article class="permission-range">
    <div class="section-heading"><h3>${escape(serviceName(profile))}</h3><span class="status">${source.programDigest===profile.programDigest?'已授权范围':'服务已更新'}</span></div>
    <p class="fine">独立授权范围 ${index+1} · 仅在对应连接和任务中生效</p>
    ${source.programDigest===profile.programDigest?'':'<p class="notice">以下为原版本的授权记录。服务内容已更新，使用新版前需要重新确认范围。</p>'}
    <dl><dt>允许做什么</dt><dd><ul>${source.operations.map(id=>`<li>${escape(operationName(view,id))}</li>`).join('')}</ul></dd>
    <dt>可以使用哪些资料</dt><dd>${resources(rows)}</dd><dt>资料用途</dt><dd><ul>${purposes(parent.channels)}</ul></dd>
    <dt>有效至</dt><dd>${escape(expiry(member,until))}</dd></dl>${revoke('revoke_source',source.installationId,source.bindingId)}</article>`).join('');
  const taskRanges=active.flatMap(grant=>{
    if(grant.kind!=='task_data')return [];
    const task=view.tasks.find(item=>item.id===grant.taskId),parent=parents.find(item=>item.id===grant.parentGrant.id&&item.revision===grant.parentGrant.revision);
    if(!task||!parent||task.requestRevision!==grant.requestRevision)return [];
    return [`<article class="permission-range"><h3>${escape(task.title||'你提交的任务')}</h3><p class="fine">仅限这项任务，不适用于其他任务</p><dl><dt>允许做什么</dt><dd>${grant.operations.map(operation=>escape(taskOperationNames[operation])).join('、')}</dd><dt>选定的已有资料</dt><dd>${inputSummary(view,grant.inputs)}</dd><dt>允许接收的服务结果</dt><dd>${resources(grant.outputs)}</dd><dt>资料用途</dt><dd><ul>${purposes(grant.channels)}</ul></dd><dt>有效至</dt><dd>${escape(expiry(member,grant.expiresAt))}</dd></dl>${revoke('revoke',grant.installationId,grant.id)}</article>`];
  }).join('');
  const boundaries=parents.map((parent,index)=>parent.kind==='agent_access'?`<details class="permission-boundary"><summary>预设权限范围 ${index+1} · 至 ${escape(expiry(member,parent.expiresAt))}</summary><p>这是可申请使用的范围上限；具体服务和任务仍按各自授权处理。</p><dl><dt>可申请处理的事项</dt><dd>${parent.capabilityIds.map(id=>{const profile=view.profiles.find(item=>item.programId===id||item.capabilityId===id);return escape(profile?serviceName(profile):'原授权中选定的事项');}).join('、')}</dd><dt>资料范围上限</dt><dd>${resources(parent.resources)}</dd><dt>资料用途</dt><dd><ul>${purposes(parent.channels)}</ul></dd></dl>${revoke('revoke',parent.installationId,parent.id)}</details>`:'').join('');
  return `<section class="permission-overview" aria-label="客户授权总览"><p class="eyebrow">你的授权</p><h1>你允许 EIGOS<br>做什么。</h1><p class="lead">查看已授权的事项、可用资料、用途与有效期。你可以随时查看收回某项授权的影响。</p><p class="muted">以下范围分别生效，不会在不同连接或任务间自动通用。实际处理还须满足服务和任务本身的条件。</p>
    <h2>服务授权范围</h2>${services||'<div class="empty"><p>当前没有已授权的服务范围。</p><p>预设的范围上限不会自动启用服务或读取资料。</p></div>'}
    <h2>仅用于具体任务</h2>${taskRanges||'<p class="muted">当前没有需要单独列出的有效任务授权。</p>'}
    <h2>你设定的权限边界</h2>${boundaries||'<p class="muted">当前没有有效的预设权限范围。</p>'}</section>`;
}

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
  return memberLayout(`<style>
    .permission-overview h1{font-family:"Iowan Old Style","Songti SC",Georgia,serif;font-weight:500}.permission-overview .lead{font-size:18px;line-height:1.7}.permission-range{padding:28px 0;border-top:1px solid var(--line)}.permission-range h3{font-size:21px;margin:0}.permission-range dl{margin:22px 0;display:grid;grid-template-columns:128px 1fr;gap:14px 20px;font-size:14px;line-height:1.7}.permission-range dt{color:var(--muted)}.permission-range dd{margin:0;overflow-wrap:anywhere}.permission-range ul{margin:0;padding-left:20px}.permission-data small{display:block;font-size:12px;color:var(--muted)}.permission-data li{margin-bottom:10px}.permission-boundary{margin:16px 0}.permission-boundary dl{font-size:13px;line-height:1.7}.permission-boundary dd{margin:8px 0 20px}.permission-range form{margin-top:20px}.permission-overview h2{margin-top:42px}.permission-help p{font-size:14px;line-height:1.8}.permission-technical{margin-top:32px}.permission-technical .technical-body{font-size:13px}.permission-technical h2{font-size:18px}@media(max-width:760px){.permission-range dl{grid-template-columns:1fr;gap:5px}.permission-range dd{margin-bottom:14px}}
    </style>${customerPermissionOverview(view,member,csrf)}<aside class="permission-help"><h2>你始终保留控制</h2><p>每份授权都有自己的范围和期限。选择“查看收回授权的影响”，核对后可以收回该项权限；历史结果和审计记录会保留。</p><h2>什么时候会再问你</h2><p>请求超出已有范围、需要额外资料，或业务规则要求单独确认时，再由你决定。日常的权限校验由系统自动完成。</p><h2>金额与对外操作</h2><p>这里显示数据与服务访问范围，不代表已经批准付款、购买或对外发送。具体业务操作仍按对应任务的许可执行。</p><details class="permission-technical" id="permission-technical"><summary>高级连接与权限明细</summary><div class="technical-body"><p>用于检查具体连接、授权记录及单个任务设置。这里的名称与编号是技术信息。</p><h2>当前授权记录</h2>${current}${sourceGrants}<details><summary>新增安装授权上限</summary>${ceilings}</details><details><summary>批准来源操作</summary>${sourceForms||'<p>暂无可用来源。</p>'}</details><h2>任务范围与接管</h2>${taskForm}<details><summary>原操作查证</summary>${recovery}${view.recoveries.map(r=>`<p><code>${escape(r.intentId.slice(0,8))}</code> · ${escape(r.state)} · 已读 ${r.attempts} 次</p>`).join('')}</details></div></details><p><a href="/members">返回会员中心</a></p></aside>`,notice,'你的授权范围');
}

export function permissionReviewPage(review:PermissionReview,view:View,member:Member,csrf:string,id:string) {
  const input=review.input,install=view.installations.find(a=>a.id===input.installationId);
  const revoking=review.kind.startsWith('revoke');
  const title=review.kind==='revoke_source'?'收回这项服务授权':review.kind==='revoke'?'收回这项授权范围':review.kind==='recovery'?'允许查询原操作状态':review.kind==='task'?'确认这项任务的授权':review.kind==='source'?'确认服务访问范围':'确认预设的权限范围';
  const service=(id:string)=>{const profile=view.profiles.find(p=>p.programId===id||p.capabilityId===id);return profile?serviceName(profile):'原范围选定的服务';};
  const rows:{label:string;value:unknown}[]=[];
  let resources=input.resources as {type:string;fields:string[]}[]|undefined;
  let inputs=input.inputs as {object:{type:string;id:string};objectRevision:number;fields:string[]}[]|undefined;
  let selectedChannels=input.channels as string[]|undefined,expiresAt=input.expiresAt;
  if(review.kind==='agent')rows.push({label:'可申请处理的事项',value:(input.capabilityIds as string[]).map(service).join('、')},{label:'范围说明',value:'这是可申请使用的权限上限。具体服务与任务仍按各自授权处理。'});
  if(review.kind==='source')rows.push({label:'服务',value:service(String(input.programId))},{label:'允许做什么',value:(input.operations as string[]).map(operation=>operationName(view,operation)).join('、')},{label:'可接收的资料',value:(input.outputTypes as string[]).map(type=>dataName(view,type)).join('、')});
  if(review.kind==='revoke_source') {
    for(const source of view.sources.filter(s=>s.installationId===input.installationId&&s.bindingId===input.bindingId))rows.push({label:'服务',value:service(source.programId)},{label:'将停止的操作',value:source.operations.map(operation=>operationName(view,operation)).join('、')},{label:'将收回的资料范围',value:source.outputTypes.map(type=>dataName(view,type)).join('、')});
    rows.push({label:'影响',value:'停止通过这项授权调用该服务，并收回依赖其数据的任务授权。已发生的操作与审计记录保留。'});
  }
  if(review.kind==='source'||review.kind==='revoke_source') {
    const parent=view.grants.find(grant=>grant.kind==='agent_access'&&grant.installationId===input.installationId&&grant.status==='active');
    const source=view.sources.find(source=>source.installationId===input.installationId&&source.bindingId===input.bindingId);
    const outputTypes=review.kind==='source'?input.outputTypes as string[]:source?.outputTypes??[];
    resources=parent?.kind==='agent_access'?parent.resources.filter(row=>outputTypes.includes(row.type)):[];
    selectedChannels=parent?.channels;
  }
  if(review.kind==='task')rows.push({label:'任务',value:view.tasks.find(task=>task.id===input.taskId)?.title??'你选择的任务'},{label:'允许做什么',value:(input.operations as string[]).map(operation=>taskOperationNames[operation]).join('、')},{label:'任务处理方式',value:input.takeover?'允许继续处理，并收回本任务其他连接的旧授权':'仅允许访问列出的任务资料'});
  if(review.kind==='recovery') {
    const operation=view.recoveryCandidates.find(o=>o.intentId===input.intentId);
    rows.push({label:'原任务',value:view.tasks.find(task=>task.id===operation?.taskId)?.title??'原来提交的任务'},{label:'原操作',value:operation?operationName(view,operation.action):'原来提交的操作'},{label:'范围',value:'只查询原操作状态，最多三次、一小时内有效；不会发起新操作。'});
  }
  if(review.kind==='revoke') {
    const grant=view.grants.find(grant=>grant.id===input.grantId&&grant.installationId===input.installationId);
    if(grant) {
      selectedChannels=grant.channels;expiresAt=grant.expiresAt;
      if(grant.kind==='agent_access') {
        resources=grant.resources;
        rows.push({label:'将收回的事项范围',value:grant.capabilityIds.map(service).join('、')},{label:'影响',value:'收回这份预设权限及其依赖的任务授权。已发生的操作和历史记录保留。'});
      }else {
        resources=grant.outputs;inputs=grant.inputs;
        rows.push({label:'任务',value:view.tasks.find(task=>task.id===grant.taskId)?.title??'原授权对应的任务'},{label:'将收回的操作',value:grant.operations.map(operation=>taskOperationNames[operation]).join('、')},{label:'影响',value:'停止通过这份授权读取资料、回读结果或继续处理任务。已发生的操作与历史记录保留。'});
      }
    }
  }
  const taskOutputs=review.kind==='task'?(input.programIds as string[]).map(programId=>{
    const source=view.sources.find(source=>source.programId===programId&&source.installationId===input.installationId);
    const parent=view.grants.find(grant=>grant.kind==='agent_access'&&grant.installationId===input.installationId&&grant.status==='active');
    return `<h3>${escape(service(programId))}</h3>${resourceSummary(view,parent?.kind==='agent_access'?parent.resources.filter(row=>source?.outputTypes.includes(row.type)):[])}`;
  }).join(''):'';
  return memberLayout(`<section><p class="eyebrow">确认范围</p><h1>${title}</h1><p>只影响下面列出的服务、资料或任务。</p>
    ${rows.map(row=>`<p><strong>${escape(row.label)}</strong><br>${escape(row.value)}</p>`).join('')}
    ${expiresAt?`<p><strong>${revoking?'原授权有效至':'有效至'}</strong><br>${escape(expiry(member,expiresAt))}（${escape(member.timezone)}）</p>`:''}
    ${selectedChannels?`<h2>资料用途</h2><ul>${purposes(selectedChannels)}</ul>`:''}
    ${resources?`<h2>${revoking?'将收回的资料范围':'可使用的资料范围'}</h2>${resourceSummary(view,resources)}`:''}
    ${inputs?`<h2>选定的已有资料</h2>${inputSummary(view,inputs)}`:''}
    ${review.kind==='task'?(()=>{const parent=view.grants.find(grant=>grant.kind==='agent_access'&&grant.installationId===input.installationId&&grant.status==='active');return `<h2>本任务的提交内容</h2>${resourceSummary(view,parent?.kind==='agent_access'?parent.resources.filter(row=>row.type==='ServiceRequest'):[])}`;})():''}
    ${review.kind==='task'?`<h2>允许接收的服务结果</h2>${taskOutputs||'<p>没有新增服务结果的授权。</p>'}`:''}
    <details><summary>高级明细：完整字段上限与连接记录</summary><p>${escape(install?.name??'原授权连接')}</p><pre class="review-data">${escape(JSON.stringify(input,null,2))}</pre></details>
    <form method="post" action="/members/permissions/approve">${hidden('_csrf',csrf)}${hidden('reviewId',id)}<button class="primary" type="submit" name="confirm" value="approve">${revoking?'确认收回授权':'确认以上范围'}</button></form><p><a href="/members/permissions">返回授权总览</a></p></section><aside><h2>${revoking?'本次收回的范围':'本次确认的范围'}</h2><p>${revoking?'只收回本页列出的范围及其依赖授权。':'只确认本页列出的范围。所选资料项目包含其完整子项。'}</p><p>服务内容、资料版本或授权状态发生变化时，需要重新查看。购买、付款或对外发送仍按对应任务的许可执行。</p><p class="fine">此确认页五分钟内有效。</p></aside>`,undefined,'确认授权范围');
}
