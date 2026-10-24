/** Static shell: definition text and credentials never enter server-rendered HTML. */
export function ontologyManagerPage(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>业务模型 · EIGOS</title><style>
:root{color-scheme:light;--ink:#171717;--muted:#686868;--line:#dededb;--paper:#f7f7f4}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);padding:22px max(24px,calc((100vw - 1320px)/2));background:#fff}a{color:inherit;text-decoration:none}.brand{font-size:24px;font-weight:750;letter-spacing:.14em}header nav{display:flex;gap:24px;color:var(--muted);font-size:13px}main{max-width:1368px;padding:40px 24px 72px;margin:auto}h1{font-size:38px;line-height:1.2;letter-spacing:-.035em;margin:0 0 14px}h2{font-size:20px;margin:0 0 12px}h3{font-size:15px;margin:16px 0 8px}p{margin:8px 0}small,.muted{color:var(--muted)}.intro{max-width:700px;margin-bottom:32px}.eyebrow{font-size:11px;letter-spacing:.15em;text-transform:uppercase;font-weight:650;color:var(--muted);margin-bottom:12px}.card{background:#fff;border:1px solid var(--line);border-radius:8px;padding:24px}.auth{max-width:620px}.field{display:flex;flex-direction:column;gap:6px;margin:12px 0}.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.between{justify-content:space-between}.fill{flex:1;min-width:180px}button,input,select,textarea{font:inherit}input,select,textarea{width:100%;border:1px solid #c7c7c3;border-radius:5px;background:#fff;padding:10px 12px;color:var(--ink)}input[type=checkbox]{width:auto;accent-color:#171717}button{border:1px solid #bdbdb7;border-radius:5px;padding:9px 14px;background:#fff;cursor:pointer;line-height:1.4}button:hover{background:#f0f0ec}button.primary{background:#171717;color:#fff;border-color:#171717}button.primary:hover{background:#363634}button:disabled{cursor:not-allowed;opacity:.4}button.text{padding:0;border:0;text-align:left;background:none}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid #777;outline-offset:3px}[hidden]{display:none!important}.toolbar{margin-bottom:24px;padding:16px 20px}.toolbar select{max-width:420px}.layout{display:grid;grid-template-columns:330px minmax(0,1fr);gap:24px}.stack{display:grid;gap:24px}.tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin:18px 0}.tabs button{padding:8px 3px;font-size:13px;border-color:transparent}.tabs button[aria-selected=true]{border-color:#171717;background:#171717;color:#fff}.resource{display:block;width:100%;padding:16px 0;border:0;border-bottom:1px solid #eee;border-radius:0;text-align:left;background:#fff}.resource strong{display:block;font-size:14px;overflow-wrap:anywhere}.resource small{display:block;margin-top:3px;font-size:12px;overflow-wrap:anywhere}.resource[aria-current=true]{padding-left:10px;border-left:2px solid #171717}.list{min-height:220px}.empty{padding:35px 8px;text-align:center;color:var(--muted)}.badge{display:inline-flex;border:1px solid #d8d8d1;border-radius:20px;padding:3px 10px;font-size:11px;color:#51514c;background:#f8f8f4}.meta{font-size:13px;color:var(--muted);overflow-wrap:anywhere}.rule{border-top:1px solid var(--line);margin:22px 0}.notice{margin:18px 0;padding:12px 16px;border-left:3px solid #555;background:#eeeee8;font-size:14px;overflow-wrap:anywhere}.notice.error{border-color:#8a2f25;background:#fff0ed;color:#722b23}.details{display:grid;grid-template-columns:1fr 1fr;gap:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f5f1;border:1px solid #e8e8e2;padding:16px;border-radius:5px;font:12px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace;max-height:380px;overflow:auto;margin:12px 0}textarea{font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;min-height:300px;resize:vertical}summary{cursor:pointer;font-size:13px;color:var(--muted);margin:16px 0}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}.diff-item,.release{border-top:1px solid #eee;padding:14px 0;overflow-wrap:anywhere}.diff-item button{width:100%;text-align:left}.release .row{align-items:flex-start}.release strong{font-size:14px}.section-note{font-size:13px;margin:8px 0 20px;color:var(--muted)}.history{max-height:220px;overflow:auto}.history p{font-size:12px;border-bottom:1px solid #eee;padding-bottom:8px;overflow-wrap:anywhere}.footer{margin-top:32px;color:var(--muted);font-size:12px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}#action-input{min-height:100px}#status{min-height:0}#resource-description{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:900px){.layout{grid-template-columns:1fr}.details,.pair{grid-template-columns:1fr}main{padding-top:28px}h1{font-size:30px}.list{min-height:80px;max-height:360px;overflow:auto}.card{padding:20px}header{padding:18px 24px}header nav{gap:14px}}
</style><script src="/ontology/manager.js" defer></script></head><body><header><a class="brand" href="/ontology/manager">EIGOS</a><nav><span>业务模型</span><a href="/members">会员资料</a></nav></header><main>
<div class="intro"><div class="eyebrow">Ontology workspace</div><h1>让业务规则可被理解与执行</h1><p class="muted">管理对象、关系、接口和操作。先审查变更，再发布版本；每次数据操作仍需独立授权。</p></div>
<fieldset id="manager-controls" aria-label="业务模型管理" style="border:0;margin:0;padding:0;min-width:0"><div id="status" role="status" aria-live="polite"></div><p id="busy-label" class="meta" role="status" hidden>正在处理…</p>
<section id="connection" class="card auth"><h2>连接你的工作区</h2><p class="section-note">使用已有的 EIGOS 访问令牌。令牌仅保存在当前页面，刷新或断开后清除。</p><form id="connect-form"><label class="field">访问令牌<input id="token" type="password" autocomplete="off" spellcheck="false" required></label><button class="primary" type="submit">连接</button></form></section>
<div id="workspace" hidden><section class="card toolbar"><div class="row between"><div class="row fill"><label for="namespace">业务模型</label><select id="namespace" class="fill"></select><button id="refresh" type="button">刷新</button></div><button id="disconnect" type="button">断开连接</button></div><p id="active-release" class="meta"></p><details><summary>新建业务模型</summary><form id="new-namespace" class="row"><input class="fill" id="namespace-name" placeholder="例如：办公室资源" aria-label="业务模型名称" maxlength="160" required><button type="submit">创建</button></form></details></section>
<div class="layout"><aside class="card"><div class="row between"><h2>定义目录</h2><span id="definition-count" class="badge">0 项</span></div><div class="tabs" role="tablist" aria-label="定义类别"><button data-kind="object" role="tab" aria-selected="true">对象</button><button data-kind="link" role="tab" aria-selected="false">关系</button><button data-kind="interface" role="tab" aria-selected="false">接口</button><button data-kind="action" role="tab" aria-selected="false">操作</button></div><label class="field"><span class="muted">搜索定义</span><input id="search" placeholder="名称或说明" maxlength="100"></label><label class="row"><input id="custom-only" type="checkbox" checked>只看自定义内容</label><div id="resource-list" class="list"></div><div class="row between"><button id="previous" type="button">上一页</button><button id="next" type="button">下一页</button></div><button id="new-definition" type="button" class="primary" style="width:100%;margin-top:18px">新建定义</button></aside>
<div class="stack"><section class="card"><div class="row between"><h2 id="resource-name">选择一个定义</h2><span id="resource-kind" class="badge">定义详情</span></div><p id="resource-description" class="muted">从左侧目录查看字段、依赖和可用状态。</p><p id="resource-availability" class="notice" hidden></p><p id="resource-dependencies" class="meta"></p><div class="actions"><button id="edit-definition" type="button" disabled>在草稿中编辑</button><button id="retire-definition" type="button" disabled>在草稿中退役</button></div><details><summary>查看完整定义 · JSON</summary><pre id="definition-json">尚未选择定义</pre></details><details id="editor"><summary>编辑定义 · 高级</summary><p class="section-note">修改只进入选中的草稿。API 名称、字段和依赖需通过发布校验。</p><label class="field">定义 JSON<textarea id="definition-editor" spellcheck="false" aria-label="定义 JSON"></textarea></label><button id="save-definition" class="primary" type="button" disabled>保存到草稿</button></details><details id="action-panel" hidden><summary>预览一次数据操作</summary><p class="section-note">预览准确的对象与字段变更，随后单独批准；不会下单或付款。</p><label class="field">操作参数 · JSON<textarea id="action-input" spellcheck="false">{}</textarea></label><button id="prepare-action" type="button">生成预览</button><div id="action-changes" hidden></div><details id="action-authorization" hidden><summary id="action-detail-title">查看准确授权范围</summary><pre id="action-preview" hidden></pre></details><div class="actions"><button id="approve-action" class="primary" type="button" hidden>批准这次数据变更</button><button id="read-action" type="button" hidden>更新执行结果</button></div><p id="action-status" class="meta"></p></details></section>
<section class="card"><h2>变更审查</h2><p class="section-note">草稿不会影响运行中的任务。发布后可选择启用；已有任务继续使用原版本。</p><label class="field">选择草稿<select id="draft-select"><option value="">当前已启用版本</option></select></label><form id="new-draft" class="row"><input id="draft-title" class="fill" placeholder="说明这次修改的目的" aria-label="草稿说明" maxlength="160" required><button type="submit">新建草稿</button></form><p id="draft-status" class="meta"></p><div id="diff-list"></div><button id="more-diff" type="button" hidden>查看更多变更</button><div id="diff-detail" class="pair" hidden><div><h3>发布前</h3><pre id="diff-before"></pre></div><div><h3>草稿内容</h3><pre id="diff-after"></pre></div></div><div id="validation"></div><div class="actions"><button id="validate-draft" type="button" disabled>检查此草稿</button><button id="publish-draft" class="primary" type="button" disabled>发布此版本</button><button id="discard-draft" type="button" disabled>放弃草稿</button></div></section>
<section class="card"><h2>版本与记录</h2><p class="section-note">启用版本决定新任务使用的定义，不撤销已经完成的数据变更。</p><div id="releases"></div><details><summary>查看操作记录</summary><div id="history" class="history"></div></details></section></div></div><p class="footer">定义已发布、操作可执行、数据变更已完成是三个独立状态。这里的定义管理不授予订单、付款或供应商访问权限。</p></div></fieldset></main></body></html>`;
}

export const ontologyManagerScript = String.raw`'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let credential = '', busy = false, state = { kind: 'object', offset: 0, namespace: null, draft: null, resource: null, validation: null, diffOffset: 0, pending: null };
  const labels = { object: '对象类型', link: '关系类型', interface: '接口', action: '操作类型' };
  const status = (text, error = false) => { $('status').textContent = text; $('status').className = text ? 'notice' + (error ? ' error' : '') : ''; };
  const text = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; };
  const button = (label, fn, className) => { const node = text('button', label, className); node.type = 'button'; node.addEventListener('click', () => guard(fn)); return node; };
  const guard = async fn => { if (busy) return; busy = true; $('manager-controls').disabled = true; $('busy-label').hidden = false; $('workspace').setAttribute('aria-busy', 'true'); try { await fn(); } catch (error) { status(error.message || '操作未完成，请检查当前状态。', true); } finally { busy = false; $('manager-controls').disabled = false; $('busy-label').hidden = true; $('workspace').setAttribute('aria-busy', 'false'); if (state.namespace && state.namespace.permissions) controls(); } };
  const api = async (path, input) => {
    if (!credential) throw new Error('请先连接工作区。');
    const response = await fetch('/ontology/v1/' + path, { method: 'POST', cache: 'no-store', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + credential }, body: JSON.stringify(input) });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error && data.error.message || '请求未完成（' + response.status + '）。');
    return data.result;
  };
  const query = (operation, values = {}) => api('query', { operation, ...(operation === 'list_ontologies' ? {} : { ontologyId: state.namespace.id }), ...values });
  const command = (operation, values = {}) => api('commands', { operation, ...(operation === 'create_ontology' ? {} : { ontologyId: state.namespace.id }), ...values });
  const source = () => state.draft && state.draft.status === 'open' ? { draftId: state.draft.id } : state.draft && state.draft.published ? { release: state.draft.published } : {};
  const openDraft = () => !!state.draft && state.draft.status === 'open';
  const writable = () => openDraft() && state.namespace.permissions.edit;
  const clearPending = () => { state.pending = null; $('action-preview').textContent = ''; $('action-preview').hidden = true; $('action-changes').replaceChildren(); $('action-changes').hidden = true; $('action-authorization').hidden = true; $('action-authorization').open = false; $('action-detail-title').textContent = '查看准确授权范围'; $('approve-action').hidden = true; $('read-action').hidden = true; $('action-status').textContent = ''; };
  const clearSelection = () => { clearPending(); $('action-input').value = '{}'; state.resource = null; $('resource-name').textContent = '选择一个定义'; $('resource-description').textContent = '从目录查看定义，或在草稿中添加新内容。'; $('definition-json').textContent = '尚未选择定义'; $('resource-availability').hidden = true; $('resource-dependencies').textContent = ''; $('action-panel').hidden = true; $('editor').open = false; controls(); };
  const controls = () => {
    $('new-definition').disabled = !writable(); $('save-definition').disabled = !writable();
    $('edit-definition').disabled = !writable() || !state.resource || state.resource.readOnly;
    $('retire-definition').disabled = !writable() || !state.resource || state.resource.readOnly;
    $('validate-draft').disabled = !openDraft() || !(state.namespace.permissions.edit || state.namespace.permissions.publish); $('discard-draft').disabled = !writable();
    $('publish-draft').disabled = !openDraft() || !state.namespace.permissions.publish || !state.validation || !state.validation.valid || state.validation.revision !== state.draft.revision;
    $('new-draft').querySelector('button').disabled = !state.namespace.permissions.edit;
    $('new-namespace').querySelector('button').disabled = !state.namespace.permissions.createOntology;
  };
  async function connect() {
    const list = await api('query', { operation: 'list_ontologies', limit: 50 });
    $('namespace').replaceChildren(...list.items.map(item => { const node = text('option', item.name); node.value = item.id; return node; }));
    $('connection').hidden = true; $('workspace').hidden = false;
    if (list.items.length) await loadNamespace($('namespace').value);
    else status('当前没有可访问的业务模型。');
  }
  async function loadNamespace(id) {
    state.namespace = { id }; state.draft = null; state.validation = null; state.offset = 0; state.pending = null;
    const data = await Promise.all([query('get_ontology'), query('list_drafts', { limit: 50 }), query('list_releases', { limit: 50 }), query('history')]);
    state.namespace = data[0];
    $('active-release').textContent = state.namespace.name + ' · 已启用版本 ' + state.namespace.active.releaseId.slice(0, 8);
    renderDrafts(data[1].items); renderReleases(data[2].items); renderHistory(data[3].items);
    $('draft-status').textContent = '当前浏览已启用版本。选择或新建草稿后可以编辑。'; $('diff-list').replaceChildren(); $('validation').replaceChildren(); $('diff-detail').hidden = true;
    clearSelection(); await loadResources(); status('已连接 ' + state.namespace.name + '。');
  }
  function renderDrafts(items, selected) {
    const empty = text('option', '当前已启用版本'); empty.value = '';
    $('draft-select').replaceChildren(empty, ...items.map(item => { const node = text('option', item.title + ' · ' + ({ open: '草稿', published: '已发布', discarded: '已放弃' }[item.status]) + ' · r' + item.revision); node.value = item.id; return node; }));
    $('draft-select').value = selected || '';
  }
  async function refreshDrafts(selected) { const result = await query('list_drafts', { limit: 50 }); renderDrafts(result.items, selected); }
  async function loadResources() {
    const result = await query('list_definitions', { ...source(), kind: state.kind, customOnly: $('custom-only').checked, search: $('search').value, offset: state.offset, limit: 12 });
    $('definition-count').textContent = result.total + ' 项'; $('previous').disabled = state.offset === 0; $('next').disabled = !result.page.hasMore;
    $('resource-list').replaceChildren(...result.items.map(item => { const node = button('', () => showResource(item), 'resource'); node.append(text('strong', item.name), text('small', item.id + (item.readOnly ? ' · 系统维护' : ''))); node.setAttribute('aria-current', String(state.resource && state.resource.definition.resourceId === item.resourceId)); return node; }));
    if (!result.items.length) $('resource-list').append(text('p', '此范围内还没有定义。可切换类别、调整搜索，或在草稿中新增。', 'empty'));
  }
  async function showResource(item) {
    clearPending(); $('action-input').value = '{}';
    state.resource = await query('get_definition', { ...source(), kind: item.kind, resourceId: item.resourceId });
    const resource = state.resource, definition = resource.definition;
    $('resource-name').textContent = definition.name || definition.id; $('resource-kind').textContent = labels[item.kind]; $('resource-description').textContent = definition.description;
    $('resource-dependencies').textContent = resource.dependencies.length ? '依赖：' + resource.dependencies.join('、') : '没有类型依赖。';
    $('definition-json').textContent = JSON.stringify(definition, null, 2); $('definition-editor').value = JSON.stringify(definition, null, 2);
    $('resource-availability').hidden = !resource.availability;
    if (resource.availability) $('resource-availability').textContent = ({ executable: '已接入执行能力；执行仍需准确授权。', definition_only: resource.publication === 'draft' ? '草稿尚未发布，不能执行。' : '当前仅为定义，尚未接入执行能力。', handler_unavailable: '当前身份没有可用的执行接入。' }[resource.availability.status] || '当前执行状态未知。');
    $('action-panel').hidden = !(resource.availability && resource.availability.status === 'executable' && resource.availability.kind === 'declarative');
    controls(); await loadResources();
  }
  async function loadDraft(id) {
    state.validation = null; state.diffOffset = 0; $('validation').replaceChildren(); $('diff-detail').hidden = true;
    state.draft = id ? await query('get_draft', { draftId: id }) : null;
    $('draft-status').textContent = state.draft ? state.draft.title + ' · ' + ({ open: '待审查', published: '已发布，启用状态见下方', discarded: '已放弃' }[state.draft.status]) + ' · 当前修订 r' + state.draft.revision : '当前浏览已启用版本。';
    clearSelection(); if (state.draft) await loadDiff(); else $('diff-list').replaceChildren(); await loadResources();
  }
  async function loadDiff(append = false) {
    const result = await query('diff_draft', { draftId: state.draft.id, limit: 20, offset: state.diffOffset });
    if (!append) $('diff-list').replaceChildren();
    for (const change of result.changes) { const node = text('div', '', 'diff-item'); node.append(button(({ added: '新增', modified: '修改', retired: '退役' }[change.change]) + ' · ' + labels[change.kind] + ' · ' + change.id, () => showDiff(change), 'text')); if (change.fields.length) node.append(text('small', '变化字段：' + change.fields.join('、'))); $('diff-list').append(node); }
    if (!result.total) $('diff-list').append(text('p', '草稿尚无变更。', 'muted'));
    $('more-diff').hidden = !result.page.hasMore;
  }
  async function showDiff(change) {
    const read = values => query('get_definition', { kind: change.kind, resourceId: change.resourceId, ...values }).then(value => value.definition).catch(error => { if (error.message.includes('not available')) return null; throw error; });
    const values = await Promise.all([read({ release: state.draft.base }), read({ draftId: state.draft.id })]);
    $('diff-before').textContent = values[0] ? JSON.stringify(values[0], null, 2) : '原版本无此定义'; $('diff-after').textContent = values[1] ? JSON.stringify(values[1], null, 2) : '此定义已从草稿移除'; $('diff-detail').hidden = false;
  }
  function renderReleases(items) {
    $('releases').replaceChildren(...items.map(release => {
      const active = release.ref.digest === state.namespace.active.digest, row = text('div', '', 'release'), top = text('div', '', 'row between'), info = text('div', '', 'fill');
      info.append(text('strong', '版本 ' + release.sequence + (active ? ' · 当前已启用' : ' · 已发布')), text('p', new Date(release.createdAt).toLocaleString() + ' · ' + release.ref.releaseId.slice(0, 8), 'meta'));
      const activate = button('启用此版本', async () => { await command('activate_release', { release: release.ref, expectedGeneration: state.namespace.generation }); await loadNamespace(state.namespace.id); status('已启用所选版本；新任务将使用这个版本。'); }); activate.disabled = active || !state.namespace.permissions.publish;
      top.append(info, activate); row.append(top); return row;
    }));
  }
  function renderHistory(items) { $('history').replaceChildren(...items.map(item => text('p', new Date(item.at).toLocaleString() + ' · ' + ({ created: '创建业务模型', draft_created: '创建草稿', definition_edited: '编辑定义', definition_retired: '退役定义', published: '发布版本', activated: '启用版本', draft_discarded: '放弃草稿', bootstrap: '初始化' }[item.kind] || item.kind)))); }
  const p = (description, schema = { type: 'string', minLength: 1, maxLength: 200 }) => ({ kind: 'string', description, source: 'Owner input', required: true, schema });
  function sample(kind) {
    const properties = { id: p('Stable identity'), label: p('Display label') };
    if (kind === 'object') return { id: 'NewObject', version: '1', name: '新对象', aliases: [], description: '说明对象代表什么', primaryKey: 'id', titleKey: 'label', properties, writePolicy: 'managed' };
    if (kind === 'interface') return { id: 'NewInterface', description: '定义共享的字段或能力', properties };
    if (kind === 'link') return { id: 'NewRelationship', description: '说明两端对象的关系', from: { type: 'NewObject', name: 'related', many: true }, to: { type: 'OtherObject', name: 'relatedFrom', many: true }, writePolicy: 'managed' };
    return { id: 'CreateNewObject', version: '1', kind: 'business', description: '创建内部对象记录', inputs: {}, effects: ['object_write'], changes: ['NewObject'], resultTypes: ['NewObject'], submissionCriteria: ['exact_object_write_authority'], inputSchema: { type: 'object', properties: { id: properties.id.schema, label: properties.label.schema }, required: ['id', 'label'], additionalProperties: false }, implementation: { kind: 'declarative', version: '1', conditions: [], mutations: [{ op: 'create', type: 'NewObject', id: { parameter: 'id' }, properties: { id: { parameter: 'id' }, label: { parameter: 'label' } } }] } };
  }
  const valueLabel = value => { if (value === undefined) return '未设置'; const label = typeof value === 'string' ? value : JSON.stringify(value); return label.length > 400 ? label.slice(0, 400) + '…（详见完整范围）' : label; };
  const objectLabel = ref => ref.type + ' · ' + ref.id;
  function renderChanges(groups, committed, notice) {
    const container = $('action-changes'); container.hidden = false; container.replaceChildren(text('p', notice, 'notice'));
    let count = 0;
    for (const group of groups) {
      if (groups.length > 1 && group.actionId) container.append(text('h3', '操作：' + group.actionId));
      for (const change of group.objects || []) {
        const item = text('article', '', 'diff-item');
        const operation = { create: committed ? '已新增记录' : '新增记录', update: committed ? '已更新记录' : '更新记录', tombstone: committed ? '已移除记录' : '移除记录' }[change.operation] || change.operation;
        item.append(text('h3', operation + ' · ' + objectLabel(change.ref)));
        item.append(text('p', change.expectedRevision === null ? '新建记录，无原版本。' : '依据的原版本：' + change.expectedRevision, 'meta'));
        if (change.operation === 'tombstone') item.append(text('p', committed ? '已从当前数据中移除，历史记录保留。' : '将从当前数据中移除，历史记录保留。'));
        else for (const field of change.fields || []) {
          const after = valueLabel(change.after && change.after[field]);
          item.append(text('p', field + '：' + (change.operation === 'create' ? after : valueLabel(change.before && change.before[field]) + ' → ' + after)));
        }
        container.append(item); count++;
      }
      for (const change of group.links || []) {
        const item = text('article', '', 'diff-item');
        item.append(text('h3', (change.operation === 'add' ? committed ? '已添加关系' : '添加关系' : committed ? '已移除关系' : '移除关系') + ' · ' + change.link.type));
        item.append(text('p', objectLabel(change.link.from) + ' → ' + objectLabel(change.link.to)));
        container.append(item); count++;
      }
    }
    if (!count) container.append(text('p', '没有可显示的字段变更；请查看准确范围与任务状态。', 'meta'));
  }
  function renderTask(task) {
    $('action-status').textContent = '任务 ' + task.id + ' · ' + ({ 'auth-required': '等待准确授权', submitted: '已授权，等待执行', working: '执行中', completed: '已完成并通过回读', rejected: '未执行', failed: '未完成', canceled: '已取消' }[task.state] || task.state);
    $('approve-action').hidden = task.state !== 'auth-required' || !state.namespace.permissions.execute; $('read-action').hidden = false;
    if (task.artifact) {
      const result = task.artifact.data.result;
      $('action-preview').textContent = JSON.stringify({ result, readback: task.delegation && task.delegation.acceptance }, null, 2); $('action-detail-title').textContent = '查看完整回读记录';
      if (result && Array.isArray(result.managedChanges)) renderChanges(result.managedChanges, true, task.delegation && task.delegation.acceptance && task.delegation.acceptance.accepted ? '本次变更已提交，并通过独立回读。' : '本次变更已提交，回读状态见下方任务结果。');
    }
  }
  $('connect-form').addEventListener('submit', event => { event.preventDefault(); credential = $('token').value.trim(); $('token').value = ''; guard(connect); });
  $('disconnect').addEventListener('click', () => { credential = ''; $('workspace').hidden = true; $('connection').hidden = false; state.pending = null; status('已断开连接。'); });
  window.addEventListener('pagehide', () => { credential = ''; clearPending(); $('workspace').hidden = true; $('connection').hidden = false; });
  $('namespace').addEventListener('change', () => guard(() => loadNamespace($('namespace').value)));
  $('refresh').addEventListener('click', () => guard(() => loadNamespace(state.namespace.id)));
  $('new-namespace').addEventListener('submit', event => { event.preventDefault(); guard(async () => { const created = await command('create_ontology', { name: $('namespace-name').value }); await connect(); $('namespace').value = created.id; await loadNamespace(created.id); }); });
  document.querySelectorAll('[data-kind]').forEach(node => node.addEventListener('click', () => guard(async () => { state.kind = node.dataset.kind; state.offset = 0; document.querySelectorAll('[data-kind]').forEach(tab => tab.setAttribute('aria-selected', String(tab === node))); clearSelection(); await loadResources(); })));
  let searchTimer; $('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => guard(async () => { state.offset = 0; await loadResources(); }), 250); });
  $('custom-only').addEventListener('change', () => guard(async () => { state.offset = 0; await loadResources(); }));
  $('previous').addEventListener('click', () => guard(async () => { state.offset = Math.max(0, state.offset - 12); await loadResources(); })); $('next').addEventListener('click', () => guard(async () => { state.offset += 12; await loadResources(); }));
  $('draft-select').addEventListener('change', () => guard(() => loadDraft($('draft-select').value)));
  $('new-draft').addEventListener('submit', event => { event.preventDefault(); guard(async () => { const draft = await command('create_draft', { title: $('draft-title').value }); await refreshDrafts(draft.id); await loadDraft(draft.id); status('草稿已创建，可以开始添加或编辑定义。'); }); });
  $('new-definition').addEventListener('click', () => { $('definition-editor').value = JSON.stringify(sample(state.kind), null, 2); $('editor').open = true; $('definition-editor').focus(); });
  $('edit-definition').addEventListener('click', () => { $('definition-editor').value = JSON.stringify(state.resource.definition, null, 2); $('editor').open = true; $('definition-editor').focus(); });
  $('save-definition').addEventListener('click', () => guard(async () => { const definition = JSON.parse($('definition-editor').value); const saved = await command('put_definition', { draftId: state.draft.id, expectedRevision: state.draft.revision, kind: state.kind, definition }); await refreshDrafts(saved.id); await loadDraft(saved.id); status('定义已保存到草稿，尚未发布。'); }));
  $('retire-definition').addEventListener('click', () => guard(async () => { const saved = await command('retire_definition', { draftId: state.draft.id, expectedRevision: state.draft.revision, resourceId: state.resource.definition.resourceId }); await refreshDrafts(saved.id); await loadDraft(saved.id); status('退役变更已加入草稿；发布校验会检查依赖与历史数据。'); }));
  $('more-diff').addEventListener('click', () => guard(async () => { state.diffOffset += 20; await loadDiff(true); }));
  $('validate-draft').addEventListener('click', () => guard(async () => { state.validation = await query('validate_draft', { draftId: state.draft.id }); $('validation').replaceChildren(text('p', state.validation.valid ? '检查通过，可以发布当前修订。' : '检查未通过，请处理以下问题后重新检查。', 'notice' + (state.validation.valid ? '' : ' error')), ...state.validation.issues.map(issue => text('p', issue.message, 'meta'))); if (state.validation.unboundSourceFieldCount) $('validation').append(text('p', '仍有 ' + state.validation.unboundSourceFieldCount + ' 个来源字段未绑定，缺少来源时保持未知。', 'meta')); controls(); }));
  $('publish-draft').addEventListener('click', () => guard(async () => { const published = await command('publish_draft', { draftId: state.draft.id, expectedRevision: state.draft.revision }); await refreshDrafts(published.draft.id); await loadDraft(published.draft.id); const releases = await query('list_releases', { limit: 50 }); renderReleases(releases.items); const history = await query('history'); renderHistory(history.items); status('版本已发布。需要让新任务使用时，请在下方启用此版本。'); }));
  $('discard-draft').addEventListener('click', () => guard(async () => { await command('discard_draft', { draftId: state.draft.id, expectedRevision: state.draft.revision }); await loadNamespace(state.namespace.id); status('草稿已放弃，当前运行版本保持不变。'); }));
  $('prepare-action').addEventListener('click', () => guard(async () => { const input = JSON.parse($('action-input').value), action = state.resource.definition.id, fingerprint = JSON.stringify({ ontologyId: state.namespace.id, action, input }); const requestId = state.pending && state.pending.fingerprint === fingerprint ? state.pending.requestId : crypto.randomUUID(); const result = await api('actions/prepare', { ontologyId: state.namespace.id, action, input, requestId }); state.pending = { fingerprint, requestId, task: result.task }; $('action-preview').hidden = false; $('action-preview').textContent = JSON.stringify(result.preview, null, 2); $('action-authorization').hidden = false; $('action-authorization').open = false; $('action-detail-title').textContent = '查看准确授权范围'; renderChanges([result.preview], false, result.preview.status === 'stale' ? '原预览已失效，请读取当前数据后重新准备。' : '以下变更尚未提交。请审查对象、原版本和字段值，再批准这一次操作。'); renderTask(result.task); }));
  $('action-input').addEventListener('input', clearPending);
  $('approve-action').addEventListener('click', () => guard(async () => { const task = state.pending.task, permit = task.delegation.authorizationRequest; const result = await api('actions/approve', { taskId: task.id, requestId: crypto.randomUUID(), planDigest: permit.planDigest, objectWrite: permit.objectWrite, expiresAt: new Date(Date.now() + 300000).toISOString() }); state.pending.task = result.task; renderTask(result.task); }));
  $('read-action').addEventListener('click', () => guard(async () => { const result = await query('get_action_task', { taskId: state.pending.task.id }); state.pending.task = result.task; renderTask(result.task); }));
})();`;
