const $ = (selector) => document.querySelector(selector);
const state = {
  token: sessionStorage.getItem('eigos_token'),
  identity: null,
  ontology: 'Eigos',
  page: 'objects',
  model: null,
  membership: null,
  raw: null,
  scenario: null,
  selected: null,
  rows: [],
  cursor: undefined,
  session: null,
};
let cleanup = () => {};

function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (value !== undefined && value !== false)
      node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity))
    if (child !== undefined && child !== null && child !== false && child !== true)
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
function notice(message, error = false) {
  $('#notice').textContent = message;
  $('#notice').hidden = false;
  $('#notice').style.background = error ? '#853c31' : '#20342e';
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => {
    $('#notice').hidden = true;
  }, 6500);
}
function button(label, action, className = '') {
  return element(
    'button',
    {
      class: className,
      onclick: async (event) => {
        const target = event.currentTarget;
        target.disabled = true;
        try {
          await action(event);
        } catch (error) {
          notice(error.message, true);
        } finally {
          target.disabled = false;
        }
      },
    },
    label,
  );
}
function select(options, value, change) {
  const node = element(
    'select',
    {},
    options.map((option) => {
      const [key, label] = Array.isArray(option) ? option : [option, option];
      return element('option', { value: key, selected: String(key) === String(value) }, label);
    }),
  );
  if (change) node.addEventListener('change', () => change(node.value));
  return node;
}
let fieldSequence = 0;
function field(label, input, hint) {
  const id = 'field-' + ++fieldSequence,
    caption = element('label', { id: id + '-label' }, label);
  if (input.matches('input,select,textarea')) {
    input.id ||= id;
    caption.setAttribute('for', input.id);
  } else {
    input.setAttribute('role', 'group');
    input.setAttribute('aria-labelledby', id + '-label');
  }
  return element('div', { class: 'field' }, caption, input, hint && element('small', {}, hint));
}
function heading(title, description, ...actions) {
  return element(
    'div',
    { class: 'page-heading' },
    element('div', {}, element('h1', {}, title), description && element('p', {}, description)),
    element('span', { class: 'spacer' }),
    ...actions,
  );
}
function empty(text) {
  return element('div', { class: 'empty' }, text);
}
function surface(...children) {
  return element('section', { class: 'surface' }, ...children);
}
function table(headers, rows, click) {
  return element(
    'div',
    { class: 'scroll' },
    element(
      'table',
      {},
      element(
        'thead',
        {},
        element(
          'tr',
          {},
          headers.map((text) => element('th', {}, text)),
        ),
      ),
      element(
        'tbody',
        {},
        rows.map((row, index) =>
          element(
            'tr',
            {
              class: click ? 'selectable' : '',
              onclick: click
                ? () => Promise.resolve(click(index)).catch((error) => notice(error.message, true))
                : () => {},
            },
            row.map((value) => element('td', {}, value ?? '—')),
          ),
        ),
      ),
    ),
  );
}
function modal(title, contents) {
  $('#editor-title').textContent = title;
  $('#editor-content').replaceChildren(contents);
  $('#editor').showModal();
}
function jsonInput(value) {
  const input = element('textarea', { spellcheck: false });
  input.value = JSON.stringify(value, null, 2);
  return input;
}
function stringify(value) {
  return value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
}
function titleOf(object) {
  const type = state.model?.objectTypes.find((type) => type.apiName === object.ref.type);
  return String(object.properties[type?.titleProperty ?? 'name'] ?? object.ref.id);
}
function currentType() {
  return $('#object-type')?.value ?? state.model?.objectTypes[0]?.apiName;
}
function download(name, data, mime = 'application/json') {
  const url = URL.createObjectURL(
    new Blob([typeof data === 'string' ? data : JSON.stringify(data, null, 2)], { type: mime }),
  );
  const link = element('a', { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function request(path, input, options = {}) {
  const token = state.token;
  const response = await fetch(path, {
    method: input === undefined ? 'GET' : 'POST',
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(input === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
    body: input === undefined ? undefined : JSON.stringify(input),
    ...options,
  });
  const body = await response.json().catch(() => ({ error: '服务返回了无法读取的结果' }));
  if (!response.ok) {
    if (response.status === 401 && token && token === state.token) {
      state.token = null;
      state.identity = null;
      state.model = null;
      state.raw = null;
      state.scenario = null;
      state.session = null;
      sessionStorage.removeItem('eigos_token');
      $('#connection').textContent = '登录已过期';
      $('#connect').hidden = false;
      $('#account').hidden = true;
      $('#logout').hidden = true;
      $('#definition-status').textContent = '连接后加载已授权的定义';
      $('#main').replaceChildren(empty('请重新连接账户。'));
    }
    throw new Error(body.error || '请求失败');
  }
  return body;
}
const service = (name, input = {}) =>
  request('/ontology/services/' + name, { ...input, _ontology: state.ontology });
const query = (input) =>
  request('/ontology/query', {
    ontology: state.ontology,
    query: input,
    ...(state.scenario ? { scenarioId: state.scenario } : {}),
  });
// The relationship service rejects more than 100 objects, so related objects page through
// the authorized Link query. A short page does not end the read; only an empty cursor does.
const relatedObjectLimit = 1000;
function linkTarget(type, link) {
  for (const definition of state.model?.linkTypes ?? []) {
    if (definition.from.type === type && definition.from.name === link) return definition.to.type;
    if (definition.to.type === type && definition.to.name === link) return definition.from.type;
  }
}
async function relatedObjects(object, link, { scenarioId = state.scenario, complete = false } = {}) {
  const type = linkTarget(object.type, link);
  if (!type) throw new Error('当前定义中没有可读取的关系：' + link);
  const items = [];
  let cursor;
  do {
    const page = await request('/ontology/query', {
      ontology: state.ontology,
      query: { type, from: { object, link }, limit: 100, ...(cursor ? { cursor } : {}) },
      ...(scenarioId ? { scenarioId } : {}),
    });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor && items.length < relatedObjectLimit);
  if (cursor && complete) throw new Error(`关联对象超过 ${relatedObjectLimit} 个，无法在此完整编辑。`);
  return { items, truncated: Boolean(cursor) };
}
const relatedNotice = (related) =>
  related.truncated ? [element('p', { class: 'subtle' }, `仅显示前 ${related.items.length} 个关联对象。`)] : [];
async function applyAction(action, input, scenarioId = state.scenario) {
  const requestId = crypto.randomUUID();
  const result = await request('/ontology/actions', {
    ontology: state.ontology,
    action,
    input,
    requestId,
    ...(scenarioId ? { scenarioId } : {}),
  });
  sessionStorage.setItem('eigos_last_action', requestId);
  return result;
}
async function connected() {
  const identity = await request('/identity');
  const membership = await service('workbench_access');
  state.membership = membership;
  state.model = membership.role === 'member' ? null
    : await request('/ontology?ontology=' + encodeURIComponent(state.ontology));
  if (membership.role === 'member') state.page = 'published';
  document.querySelectorAll('[data-page]').forEach(item => {
    item.hidden = item.dataset.page !== 'published' &&
      (membership.role === 'member' || item.dataset.page === 'rules' && !membership.canAuthorWorkflows);
    item.classList.toggle('active', item.dataset.page === state.page);
  });
  $('#ontology-name').disabled = membership.role === 'member';
  state.identity = identity;
  $('#connection').textContent = '已连接';
  $('#connect').hidden = true;
  $('#account').hidden = false;
  $('#logout').hidden = false;
  $('#definition-status').textContent = membership.ontology + ' · 版本 ' + membership.version;
  state.raw = null;
  await render();
  return identity;
}
async function connectToken(token) {
  state.token = token;
  try {
    await connected();
    sessionStorage.setItem('eigos_token', token);
  } catch (error) {
    state.token = null;
    sessionStorage.removeItem('eigos_token');
    throw error;
  }
}
async function login() {
  const config = await request('/workbench/config');
  const content = $('#login-options');
  const dialog = $('#login');
  const status = $('#login-status');
  const attempt = new AbortController();
  dialog.onclose = () => attempt.abort();
  content.replaceChildren();
  status.textContent = '';
  if (config.deviceLogin)
    content.append(
      button(
        '通过账户登录',
        async () => {
          try {
            status.textContent = '正在准备登录…';
            const started = await request('/workbench/login/start', {}, { signal: attempt.signal });
            status.replaceChildren(
              element('span', {}, '在登录页面确认代码 ' + started.userCode + '。 '),
              element('a', { href: started.url, target: '_blank', rel: 'noopener noreferrer' }, '打开登录页面'),
            );
            const expires = Date.now() + (started.expiresIn ?? 900) * 1000;
            let interval = started.interval;
            while (!attempt.signal.aborted && dialog.open && Date.now() < expires) {
              await new Promise((resolve) => setTimeout(resolve, interval * 1000));
              if (attempt.signal.aborted || !dialog.open || Date.now() >= expires) break;
              const result = await request('/workbench/login/poll', { id: started.id }, { signal: attempt.signal });
              if (result.pending) {
                interval = result.interval;
                continue;
              }
              await connectToken(result.accessToken);
              dialog.close();
              return;
            }
            if (!attempt.signal.aborted) status.textContent = '登录已过期，请重新开始。';
          } catch (error) {
            if (!attempt.signal.aborted) status.textContent = error.message;
          }
        },
        'primary',
      ),
    );
  if (config.development || !config.deviceLogin) {
    const token = element('input', {
      type: 'password',
      autocomplete: 'off',
      placeholder: config.development ? '本地访问密钥' : '已有账户访问令牌',
    });
    content.append(
      field(
        config.development ? '本地开发连接' : '使用已有登录凭据',
        token,
        config.deviceLogin ? '' : '管理员可配置 OAuth 客户端以启用账户登录。',
      ),
      button(
        '连接',
        async () => {
          const value = token.value.trim();
          if (!value) throw new Error('请输入访问凭据');
          await connectToken(value);
          dialog.close();
        },
        'primary',
      ),
    );
  }
  dialog.showModal();
}
function jsonSchemaForm(schema, initial = {}) {
  const root = element('div'),
    readers = {};
  if (schema.oneOf || schema.anyOf) {
    const choices = (schema.oneOf ?? schema.anyOf).filter((choice) => choice.type !== 'null');
    const labels = choices.map((choice, index) => [
      String(index),
      choice.properties?.status?.const ?? choice.title ?? '选项 ' + (index + 1),
    ]);
    let selected = Math.max(
      0,
      choices.findIndex((choice) => choice.properties?.status?.const === initial.status),
    );
    const picker = select(labels, String(selected)),
      holder = element('div');
    let form;
    const draw = () => {
      form = jsonSchemaForm(choices[Number(picker.value)], initial);
      holder.replaceChildren(form.node);
    };
    picker.onchange = draw;
    draw();
    root.append(field('响应类型', picker), holder);
    return { node: root, read: () => form.read() };
  }
  const propertyNames = Object.keys(schema.properties ?? {});
  for (const name of propertyNames) {
    const definition = schema.properties[name],
      required = (schema.required ?? []).includes(name);
    let type = Array.isArray(definition.type)
      ? definition.type.find((type) => type !== 'null')
      : definition.type;
    let control, read;
    if (Object.hasOwn(definition, 'const')) {
      control = element('input', { value: String(definition.const), disabled: true });
      read = () => definition.const;
    } else if (definition.enum) {
      control = select(
        [...(required ? [] : [['', '未设置']]), ...definition.enum],
        initial[name] ?? definition.default ?? (required ? definition.enum[0] : ''),
      );
      read = () =>
        control.value === '' ? undefined : definition.enum.find((value) => String(value) === control.value);
    } else if (type === 'boolean') {
      control = element('input', { type: 'checkbox' });
      control.checked = initial[name] ?? definition.default ?? false;
      read = () => control.checked;
    } else if (type === 'object' && definition.properties) {
      const nested = jsonSchemaForm(definition, initial[name] ?? {});
      control = element('fieldset', {}, nested.node);
      read = () => {
        const value = nested.read();
        return !required && !Object.keys(value).length ? undefined : value;
      };
    } else if (type === 'array' || type === 'object' || definition.anyOf || definition.oneOf) {
      control = jsonInput(initial[name] ?? definition.default ?? (type === 'array' ? [] : {}));
      read = () => (control.value.trim() ? JSON.parse(control.value) : undefined);
    } else if (definition.format === 'date-time') {
      control = element('input', { type: 'datetime-local' });
      if (initial[name]) {
        const date = new Date(initial[name]);
        control.value = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 16);
      }
      read = () => (control.value ? new Date(control.value).toISOString() : undefined);
    } else {
      control = element('input', {
        type: type === 'number' || type === 'integer' ? 'number' : 'text',
        placeholder: definition.format === 'date-time' ? '2026-11-20T09:00:00+08:00' : '',
        step: type === 'integer' ? '1' : 'any',
      });
      control.value = initial[name] ?? definition.default ?? '';
      read = () =>
        control.value === ''
          ? undefined
          : type === 'number' || type === 'integer'
            ? Number(control.value)
            : control.value;
    }
    root.append(field(name + (required ? ' *' : ''), control, definition.description));
    readers[name] = read;
  }
  return {
    node: root,
    read() {
      const result = {};
      for (const [name, read] of Object.entries(readers)) {
        const value = read();
        if (value !== undefined) result[name] = value;
      }
      return result;
    },
  };
}
function displayProperty(value, property) {
  if (value == null) return '—';
  const struct = property?.struct;
  if (struct && typeof value === 'object') {
    const structType = state.model.structTypes?.find((type) => type.apiName === struct.type);
    const main = struct.mainField ?? structType?.mainField;
    let selected = value;
    if (Array.isArray(value) && struct.reducer) {
      const reducer = struct.reducer;
      if (reducer.op === 'first') selected = value[0];
      else if (reducer.op === 'last') selected = value.at(-1);
      else
        selected = [...value]
          .filter((item) => item?.[reducer.field] != null)
          .sort((a, b) =>
            a[reducer.field] > b[reducer.field] ? 1 : a[reducer.field] < b[reducer.field] ? -1 : 0,
          ).at(reducer.op==='min'?0:-1);
    }
    if (main)
      return stringify(Array.isArray(selected) ? selected.map((item) => item?.[main]) : selected?.[main]);
  }
  const format = property?.format ?? property?.metadata?.format;
  if (typeof value === 'number' && format && ['number', 'percent'].includes(format.kind))
    return new Intl.NumberFormat(format.locale ?? 'zh-CN', {
      style: format.kind === 'percent' ? 'percent' : 'decimal',
      minimumFractionDigits: format.minimumFractionDigits,
      maximumFractionDigits: format.maximumFractionDigits,
    }).format(value);
  if (typeof value === 'number' && format?.kind === 'currency')
    return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: format.currency || 'CNY' }).format(
      value,
    );
  if (property?.schema?.format === 'date-time') return new Date(value).toLocaleString();
  return stringify(value);
}
async function renderObjects() {
  const visibleTypes = state.model.objectTypes.filter(
    (type) => !state.group || type.groups?.includes(state.group),
  );
  const type = visibleTypes.some((type) => type.apiName === state.type)
    ? state.type
    : visibleTypes[0]?.apiName;
  state.type = type;
  state.selected = null;
  const groupSelect = select(
    [['', '全部分组'], ...(state.model.typeGroups ?? []).map((group) => [group.apiName, group.displayName])],
    state.group ?? '',
    (value) => {
      state.group = value;
      renderObjects();
    },
  );
  const typeSelect = select(
    visibleTypes.map((type) => [type.apiName, type.displayName]),
    type,
    (value) => {
      state.type = value;
      renderObjects();
    },
  );
  typeSelect.id = 'object-type';
  const search = element('input', { type: 'search', placeholder: '搜索对象名称或属性值' });
  const mode = select(
    [
      ['text', '文字搜索'],
      ['semantic', '语义搜索'],
    ],
    'text',
  );
  const semanticName = element('input', { placeholder: '语义索引名称', hidden: true });
  mode.onchange = () => {
    semanticName.hidden = mode.value !== 'semantic';
  };
  const results = surface(empty('选择对象类型后查询')),
    detail = surface(
      element(
        'div',
        { class: 'detail' },
        element('h3', {}, '对象详情'),
        empty('选择一个对象以查看属性、关系和操作。'),
      ),
    );
  const propertyNames = Object.keys(
    state.model.objectTypes.find((t) => t.apiName === type)?.properties ?? {},
  );
  const filterProperty = select(
    propertyNames,
    propertyNames.find((name) => name === 'name') || propertyNames[0],
  );
  const filterOp = select(
    [
      ['eq', '等于'],
      ['contains', '包含'],
      ['gt', '大于'],
      ['lt', '小于'],
      ['regex', '正则'],
    ],
    'eq',
  );
  const filterValue = element('input', { placeholder: '筛选值' }),
    advanced = element(
      'details',
      {},
      element('summary', {}, '筛选条件'),
      element('div', { class: 'toolbar' }, filterProperty, filterOp, filterValue),
    );
  let lastQuery, nextCursor;
  const load = async (append = false) => {
    let page;
    if (mode.value === 'semantic') {
      if (!semanticName.value) throw new Error('请输入已配置的语义索引名称');
      const found = await service('semantic_search', {
        name: semanticName.value, text: search.value,
        ...(state.scenario ? { scenarioId: state.scenario } : {}),
      });
      page = { items: found.items ?? found.results ?? [] };
      page.items = page.items.map((item) => ({...(item.object ?? item),semanticScore:item.score}));
      if(page.items.some(item=>item.ref.type!==type))throw new Error('语义索引与当前选择的对象类型不同');
    } else {
      const predicates = [];
      if (search.value)
        predicates.push({
          op: 'text',
          property: state.model.objectTypes.find((t) => t.apiName === type).titleProperty,
          value: search.value,
        });
      if (filterValue.value) {
        const fieldType = state.model.objectTypes.find((t) => t.apiName === type).properties[
          filterProperty.value
        ]?.schema.type;
        predicates.push({
          op: filterOp.value,
          property: filterProperty.value,
          value: ['number', 'integer'].includes(fieldType) ? Number(filterValue.value) : filterValue.value,
        });
      }
      lastQuery = { type, limit: 50, ...(predicates.length ? { filter: { op: 'all', predicates } } : {}) };
      page = await query({ ...lastQuery, ...(append && nextCursor ? { cursor: nextCursor } : {}) });
    }
    state.rows = append ? [...state.rows, ...page.items] : page.items;
    nextCursor = page.cursor;
    const schema = state.model.objectTypes.find((t) => t.apiName === type);
    const columns = [
      schema.titleProperty,
      ...propertyNames.filter((name) => name !== schema.titleProperty && name !== schema.primaryKey),
      schema.primaryKey,
    ].slice(0, 5);
    if(mode.value==='semantic')columns.push('__score');
    results.replaceChildren(
      state.rows.length
        ? table(
            columns.map(name=>name==='__score'?'相似度':name),
            state.rows.map((object) =>
              columns.map((name) => name==='__score'?object.semanticScore.toFixed(3):displayProperty(object.properties[name], schema.properties[name])),
            ),
            (index) => showObject(state.rows[index], detail),
          )
        : empty('没有符合条件的对象。'),
    );
    if (nextCursor) results.append(button('继续加载', () => load(true)));
    $('#result-count').textContent = `${state.rows.length} 个对象${nextCursor ? '，还有更多' : ''}`;
  };
  search.onkeydown = (event) => {
    if (event.key === 'Enter') load().catch((error) => notice(error.message, true));
  };
  $('#main').replaceChildren(
    heading(
      '对象探索',
      '查询已授权的对象，沿关系导航，并查看每项变更。',
      button('保存对象集', () => {
        const name = element('input', { placeholder: '对象集名称' }),
          setMode = select(
            mode.value==='semantic'?[['static','固定语义结果']]:[['dynamic','动态查询'],['static','固定成员']],
            mode.value==='semantic'?'static':'dynamic',
          );
        modal(
          '保存对象集',
          element(
            'div',
            {},
            field('名称', name),
            field('成员方式',setMode),
            button(
              '保存',
              async () => {
                const set=mode.value==='semantic'?{op:'refs',objects:state.rows.map(object=>object.ref)}:{op:'query',query:{...lastQuery}};
                if(set.query)delete set.query.limit;
                await service('save_set', {
                  requestId: crypto.randomUUID(),
                  name: name.value,
                  mode:setMode.value,
                  set,
                });
                $('#editor').close();
                notice('对象集已保存');
              },
              'primary',
            ),
          ),
        );
      }),
      button('语义索引', () => semanticDialog(type)),
      button('视图设置', async () => {
        const view = await service('object_view', { type }),
          checks = propertyNames.map((name) => {
            const check = element('input', { type: 'checkbox' });
            check.checked = view.properties.includes(name);
            return { name, check };
          });
        modal(
          '配置对象详情',
          element(
            'div',
            {},
            checks.map((item) => element('label', { class: 'check' }, item.check, item.name)),
            button(
              '保存视图',
              async () => {
                await service('save_object_view', {
                  ...view,
                  properties: checks.filter((item) => item.check.checked).map((item) => item.name),
                });
                $('#editor').close();
                notice('视图已保存');
              },
              'primary',
            ),
          ),
        );
      }),
    ),
    element(
      'div',
      { class: 'toolbar' },
      groupSelect,
      typeSelect,
      mode,
      search,
      semanticName,
      button('查询', () => load(), 'primary'),
    ),
    advanced,
    element(
      'div',
      { class: 'toolbar' },
      element('span', { id: 'result-count', class: 'subtle' }),
      element('span', { class: 'spacer' }),
      state.scenario && element('span', { class: 'badge' }, '当前方案 ' + state.scenario.slice(0, 8)),
      button('聚合', async () => {
        const property = select(propertyNames, propertyNames[0]),
          metric = select(['count', 'sum', 'avg', 'min', 'max'], 'count');
        modal(
          '聚合当前对象集',
          element(
            'div',
            {},
            field('计算', metric),
            field('属性', property),
            button(
              '计算',
              async () => {
                const { limit, ...q } = lastQuery;
                const result = await service('aggregate_set', {
                  set: { op: 'query', query: q },
                  metrics: {
                    value:
                      metric.value === 'count'
                        ? { op: 'count' }
                        : { op: metric.value, property: property.value },
                  },
                  ...(state.scenario ? { scenarioId: state.scenario } : {}),
                });
                modal(
                  '聚合结果',
                  table(
                    ['结果'],
                    result.items.map((item) => [stringify(item.metrics.value)]),
                  ),
                );
              },
              'primary',
            ),
          ),
        );
      }),
    ),
    element('div', { class: 'split' }, results, detail),
  );
  await load();
}
async function showObject(object, target) {
  state.selected = object;
  const type = state.model.objectTypes.find((type) => type.apiName === object.ref.type),
    view = await service('object_view', { type: object.ref.type });
  const node = element(
    'div',
    { class: 'detail' },
    element('h2', {}, titleOf(object)),
    element('p', { class: 'subtle' }, `${object.ref.type} · 修订 ${object.revision}`),
    element(
      'dl',
      {},
      view.properties
        .filter((name) => type.properties[name])
        .map((name) =>
          element(
            'div',
            { class: 'property' },
            element('dt', {}, name),
            element('dd', {}, displayProperty(object.properties[name], type.properties[name])),
          ),
        ),
    ),
  );
  const links = element('div', { class: 'list section' });
  for (const link of view.links)
    links.append(
      button(link, async () => {
        const related = await relatedObjects(object.ref, link);
        modal(
          link,
          related.items.length
            ? element(
                'div',
                {},
                ...relatedNotice(related),
                table(
                  ['对象', '类型'],
                  related.items.map((item) => [titleOf(item), item.ref.type]),
                  (index) => {
                    $('#editor').close();
                    showObject(related.items[index], target);
                  },
                ),
              )
            : empty('没有可见的关联对象。'),
        );
      }),
    );
  node.append(
    element('h3', {}, '关系'),
    links,
    element(
      'div',
      { class: 'actions' },
      button('执行操作', () => actionDialog(object)),
      button('编辑历史', async () => {
        const history = await service('edit_history', { object: object.ref });
        modal(
          '编辑历史',
          history.items.length
            ? table(
                ['操作', '时间', '修改后'],
                history.items.map((item) => [
                  item.operation,
                  new Date(item.at).toLocaleString(),
                  stringify(item.after),
                ]),
              )
            : empty('没有可见的编辑记录。'),
        );
      }),
      button('查看图谱', () => {
        state.graphRoot = object.ref;
        navigate('graph');
      }),
      button('来源身份', () => identityDialog(object)),
    ),
  );
  target.replaceChildren(node);
}
function actionDialog(object, options = {}) {
  const scenarioId = options.live ? null : state.scenario;
  const actions = options.actions
    ? state.model.actionTypes.filter(action => options.actions.includes(action.apiName))
    : state.model.actionTypes;
  if (!actions.length) throw new Error('当前身份没有可用的流程操作。');
  const picker = select(
      actions.map((action) => [action.apiName, action.apiName]),
      actions[0].apiName,
    ),
    holder = element('div');
  const draw = () => {
    const action = actions.find((action) => action.apiName === picker.value),
      initial = { ...options.initial };
    for (const [name, type] of Object.entries(action.objectParameters))
      if (
        type === object?.ref.type ||
        state.model.objectTypes.find((item) => item.apiName === object?.ref.type)?.interfaces[type]
      )
        initial[name] ??= object.ref;
    const form = jsonSchemaForm(action.parameters, initial);
    holder.replaceChildren(
      element('p', {}, action.description),
      form.node,
      element(
        'div',
        { class: 'actions' },
        button(
          scenarioId ? '提交到当前方案' : '提交操作',
          async () => {
            const result = await applyAction(action.apiName, form.read(), scenarioId);
            $('#editor').close();
            notice('操作已提交');
            if (result?.type && result?.id) {
              const current = await service('read_object', {
                object: result,
                ...(scenarioId ? { scenarioId } : {}),
              });
              state.selected = current;
            }
            await render();
          },
          'primary',
        ),
      ),
    );
  };
  picker.onchange = draw;
  draw();
  modal('对象操作', element('div', {}, picker, holder));
}

async function renderModel() {
  state.raw ??= await service('raw_definition');
  const draft = structuredClone(state.raw),
    selected = { group: 'objectTypes', index: 0 };
  const groups = [
    ['objectTypes', '对象类型'],
    ['interfaceTypes', 'Interfaces'],
    ['sharedProperties', '共享属性'],
    ['valueTypes', '值类型'],
    ['structTypes', 'Structs'],
    ['typeGroups', '类型分组'],
    ['linkTypes', '关系类型'],
    ['actionTypes', '操作类型'],
  ];
  const group = select(groups, selected.group),
    list = element('div', { class: 'list model-tree' }),
    editor = element('div', { class: 'surface pad' });
  const persist = async () => {
    const name = element('input', { placeholder: '例如：补充地点地址定义', value: '工作台定义修改' });
    modal(
      '创建定义提案',
      element(
        'div',
        {},
        field('提案名称', name),
        button(
          '保存提案',
          async () => {
            const branch = await service('create_branch', {
              ontology: state.ontology,
              name: name.value,
              body: draft,
            });
            $('#editor').close();
            notice('定义提案已保存');
            await proposalDialog(branch);
          },
          'primary',
        ),
      ),
    );
  };
  const show = (index) => {
    selected.index = index;
    const value = draft[group.value]?.[index];
    editor.replaceChildren();
    if (!value) {
      editor.append(empty('选择或添加一个定义。'));
      return;
    }
    const apiName = element('input', { value: value.apiName }),
      description = element('input', { value: value.description ?? '' });
    apiName.oninput = () => {
      value.apiName = apiName.value;
    };
    description.oninput = () => {
      value.description = description.value;
    };
    editor.append(element('h2', {}, value.apiName), field('API 名称', apiName), field('说明', description));
    if (group.value !== 'typeGroups')
      editor.append(
        field(
          '生命周期',
          select(
            [
              ['experimental', '实验'],
              ['active', '正式使用'],
              ['deprecated', '已弃用'],
            ],
            value.status ?? 'active',
            (status) => (value.status = status),
          ),
        ),
      );
    if (group.value === 'objectTypes') {
      const display = element('input', { value: value.displayName ?? value.apiName });
      display.oninput = () => (value.displayName = display.value);
      editor.append(field('显示名称', display));
      const keys = select(Object.keys(value.properties), value.primaryKey, (key) => (value.primaryKey = key)),
        titles = select(
          Object.keys(value.properties),
          value.titleProperty,
          (key) => (value.titleProperty = key),
        );
      editor.append(
        element('div', { class: 'form-grid' }, field('主键属性', keys), field('标题属性', titles)),
      );
    }
    if (value.properties) {
      const properties = element('div', { class: 'section' });
      const redraw = () =>
        properties.replaceChildren(
          table(
            ['属性', '类型或引用', '必填', ''],
            Object.entries(value.properties).map(([name, property]) => [
              name,
              property.sharedProperty ||
                property.valueType?.name ||
                property.struct?.type ||
                property.schema?.type ||
                '—',
              property.required ? '是' : '否',
              button('编辑', () => editProperty(value, name, property, redraw)),
            ]),
          ),
          button('添加属性', () =>
            editProperty(value, '', { description: '', schema: { type: 'string' }, required: false }, redraw),
          ),
        );
      redraw();
      editor.append(properties);
    }
    if (group.value === 'interfaceTypes') {
      const parents = element('input', {
        value: (value.extends ?? []).join(', '),
        placeholder: '父接口名称，逗号分隔',
      });
      parents.onchange = () =>
        (value.extends = parents.value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean));
      editor.append(field('继承接口', parents));
    }
    if (group.value === 'valueTypes') {
      const version = element('input', { value: value.version ?? '1' });
      version.onchange = () => (value.version = version.value);
      editor.append(field('版本', version));
    }
    if(group.value==='linkTypes'){
      for(const side of ['from','to']){
        value[side]??={type:draft.objectTypes[0].apiName,name:side==='from'?'related':'relatedFrom',cardinality:'many'};
        const name=element('input',{value:value[side].name});name.oninput=()=>value[side].name=name.value;
        editor.append(element('h3',{},side==='from'?'关系起点':'关系终点'),field('对象类型',select(draft.objectTypes.map(type=>type.apiName),value[side].type,type=>value[side].type=type)),field('导航名称',name),field('基数',select([['one','单个对象'],['many','多个对象']],value[side].cardinality,cardinality=>value[side].cardinality=cardinality)));
      }
    }
    if(['sharedProperties','valueTypes'].includes(group.value)){
      value.schema??={type:'string'};
      editor.append(field('基础类型',select(['string','number','integer','boolean'],value.schema.type??'string',type=>value.schema.type=type)));
      for(const [key,label] of [['pattern','文本格式（正则）'],['minimum','最小值'],['maximum','最大值'],['minLength','最短文本长度'],['maxLength','最长文本长度']]){
        const input=element('input',{value:value.schema[key]??'',type:key==='pattern'?'text':'number'});input.oninput=()=>{if(input.value==='')delete value.schema[key];else value.schema[key]=key==='pattern'?input.value:Number(input.value);};editor.append(field(label,input));
      }
    }
    if(group.value==='structTypes'){
      const fields=element('div'),draw=()=>{
        fields.replaceChildren(table(['字段','类型','必填'],Object.entries(value.fields??{}).map(([name,schema])=>[name,select(['string','number','integer','boolean'],schema.type,type=>schema.type=type),button((value.required??[]).includes(name)?'必填':'可选',()=>{value.required??=[];value.required=value.required.includes(name)?value.required.filter(item=>item!==name):[...value.required,name];draw();})])));
      };draw();const name=element('input',{placeholder:'新字段名称'});
      editor.append(fields,field('主字段',select([['','展示全部字段'],...Object.keys(value.fields??{})],value.mainField??'',selected=>{if(selected)value.mainField=selected;else delete value.mainField;})),field('添加字段',name),button('添加字段',()=>{value.fields??={};value.fields[name.value]={type:'string'};name.value='';draw();}));
    }
    if(group.value==='actionTypes'){
      const mode=select([['function','函数实现'],['rules','声明式编辑']],value.function?'function':'rules'),container=element('div');
      const draw=()=>{
        if(mode.value==='function'){
          const choices=state.model.functionTypes.filter(fn=>fn.edits),picker=select(choices.map(fn=>fn.apiName),value.function??choices[0]?.apiName);
          container.replaceChildren(field('编辑函数',picker),button('使用函数契约',()=>{const fn=choices.find(fn=>fn.apiName===picker.value);if(!fn)throw new Error('没有已发布的编辑函数');value.function=fn.apiName;value.parameters=structuredClone(fn.parameters);value.objectParameters={};value.submissionCriteria??=[];delete value.rules;delete value.result;notice('已使用该函数的输入契约');}));
        }else{
          const type=select(draft.objectTypes.map(type=>type.apiName),draft.objectTypes[0].apiName);
          container.replaceChildren(field('新建对象类型',type),button('生成创建对象规则',()=>{const object=draft.objectTypes.find(item=>item.apiName===type.value),fields=Object.entries(state.model.objectTypes.find(item=>item.apiName===type.value)?.properties??object.properties).filter(([,property])=>!property.derived);value.parameters={type:'object',properties:Object.fromEntries(fields.map(([name,property])=>[name,property.schema])),required:fields.filter(([,property])=>property.required).map(([name])=>name),additionalProperties:false};value.objectParameters={};value.submissionCriteria=[];value.rules=[{op:'createObject',object:{type:type.value,id:{parameter:object.primaryKey}},properties:Object.fromEntries(fields.map(([name])=>[name,{parameter:name}]))}];value.result={type:type.value,id:{parameter:object.primaryKey}};delete value.function;notice('创建规则已写入草稿');}));
        }
      };mode.onchange=draw;draw();editor.append(field('操作实现',mode),container);
    }
    const advanced = jsonInput(value);
    editor.append(
      element(
        'details',
        { class: 'section' },
        element('summary', {}, '完整定义与高级约束'),
        advanced,
        button('应用定义内容', () => {
          const updated = JSON.parse(advanced.value);
          draft[group.value][index] = updated;
          show(index);
          redrawList();
          notice('已应用到当前草稿');
        }),
      ),
    );
  };
  const redrawList = () =>
    list.replaceChildren(
      ...(draft[group.value] ?? []).map((value, index) =>
        button(value.displayName || value.apiName, () => show(index)),
      ),
    );
  group.onchange = () => {
    redrawList();
    show(0);
  };
  $('#main').replaceChildren(
    heading(
      '本体建模',
      '编辑类型与可复用约束，通过提案检查依赖和发布影响。',
      button('提案列表', async () => {
        const branches = await service('list_branches', { ontology: state.ontology });
        modal(
          '定义提案',
          branches.length
            ? table(
                ['名称', '状态', '修订'],
                branches.map((row) => [row.name, row.state, row.revision]),
                (index) => proposalDialog(branches[index]),
              )
            : empty('还没有定义提案。'),
        );
      }),
      button('保存为提案', persist, 'primary'),
    ),
    element(
      'div',
      { class: 'toolbar' },
      group,
      button('添加定义', () => {
        const groupName = group.value;
        const minimal =
          groupName === 'objectTypes'
            ? {
                apiName: 'NewObject',
                displayName: '新对象',
                description: '新业务对象',
                primaryKey: 'id',
                titleProperty: 'name',
                properties: {
                  id: { description: '对象标识', schema: { type: 'string' }, required: true },
                  name: { description: '名称', schema: { type: 'string' }, required: true },
                },
                interfaces: {},
              }
            : groupName === 'valueTypes'
              ? { apiName: 'NewValue', version: '1', description: '可复用业务值', schema: { type: 'string' } }
              : groupName === 'sharedProperties'
                ? {
                    apiName: 'NewProperty',
                    description: '共享属性',
                    schema: { type: 'string' },
                    required: false,
                  }
                : groupName === 'structTypes'
                  ? {
                      apiName: 'NewStruct',
                      description: '复合属性',
                      fields: { value: { type: 'string' } },
                      mainField: 'value',
                    }
                  : groupName === 'typeGroups'
                    ? {
                        apiName: 'NewGroup',
                        displayName: '新分组',
                        description: '对象类型分组',
                        objectTypes: [],
                      }
                    : groupName === 'interfaceTypes'
                      ? {
                          apiName: 'NewInterface',
                          description: '共享业务能力',
                          properties: {},
                          optionalProperties: [],
                          links: {},
                          actions: {},
                        }
                      : { apiName: 'NewDefinition', description: '请在完整定义中设置端点或规则' };
        draft[groupName] ??= [];
        draft[groupName].push(minimal);
        redrawList();
        show(draft[groupName].length - 1);
      }),
      button('导出资源包', async () => {
        const value = draft[group.value]?.[selected.index];
        if (!value) throw new Error('请选择已发布的资源');
        const kinds = {
          objectTypes: 'object',
          interfaceTypes: 'interface',
          sharedProperties: 'sharedProperty',
          valueTypes: 'valueType',
          structTypes: 'struct',
          typeGroups: 'group',
          linkTypes: 'link',
          actionTypes: 'action',
        };
        const bundle = await service('export_package', {
          ontology: state.ontology,
          resources: [
            {
              kind: kinds[group.value],
              name: value.apiName,
              ...(group.value === 'valueTypes' ? { version: value.version } : {}),
            },
          ],
        });
        download(value.apiName + '.ontology.json', bundle);
      }),
      button('迁移到其他本体', () => migrationDialog()),
      button('导入资源包', () => {
        const file = element('input', { type: 'file', accept: '.json' }),
          namespace = element('input', { placeholder: '导入前缀，如 Shared' }),
          mode = select(
            [
              ['shared', '固定版本共享引用'],
              ['copy', '复制并独立维护'],
            ],
            'shared',
          );
        modal(
          '导入资源包',
          element(
            'div',
            {},
            field('资源包', file),
            field('命名空间', namespace),
            field('导入方式', mode),
            button(
              '创建导入提案',
              async () => {
                if (!file.files[0]) throw new Error('请选择资源包');
                const result = await service('import_package', {
                  targetOntology: state.ontology,
                  namespace: namespace.value,
                  package: JSON.parse(await file.files[0].text()),
                  branchName: '导入 ' + file.files[0].name,
                  mode: mode.value,
                });
                $('#editor').close();
                await proposalDialog(result);
              },
              'primary',
            ),
          ),
        );
      }),
    ),
    element('div', { class:'split model-layout' }, list, editor),
  );
  redrawList();
  show(0);
}
function editProperty(owner, name, property, done) {
  const key = element('input', { value: name }),
    description = element('input', { value: property.description ?? '' });
  const type = select(
    ['string', 'number', 'integer', 'boolean', 'object', 'array', 'shared', 'value', 'struct', 'derived'],
    property.sharedProperty
      ? 'shared'
      : property.valueType
        ? 'value'
        : property.struct
          ? 'struct'
          : property.derived
            ? 'derived'
            : (property.schema?.type ?? 'string'),
  );
  const required = element('input', { type: 'checkbox' });
  required.checked = property.required;
  const reference = element('input', {
    placeholder: '资源名称',
    value: property.sharedProperty ?? property.valueType?.name ?? property.struct?.type ?? '',
  });
  const version = element('input', { placeholder: '值类型版本', value: property.valueType?.version ?? '1' });
  const advanced = jsonInput(property.derived ?? property.schema ?? { type: 'string' });
  modal(
    name ? '编辑属性' : '添加属性',
    element(
      'div',
      {},
      field('属性名称', key),
      field('说明', description),
      field('类型', type),
      element('label', { class: 'check' }, required, '必填属性'),
      field('共享属性、值类型或 Struct 名称', reference),
      field('值类型版本', version),
      element('details', {}, element('summary', {}, '值结构或派生表达式'), advanced),
      button(
        '应用到草稿',
        () => {
          const updated = { description: description.value, required: required.checked };
          if (type.value === 'shared') updated.sharedProperty = reference.value;
          else if (type.value === 'value')
            updated.valueType = { name: reference.value, version: version.value };
          else if (type.value === 'struct') updated.struct = { type: reference.value };
          else if (type.value === 'derived') {
            updated.derived = JSON.parse(advanced.value);
            updated.schema = property.schema ?? { type: 'number' };
            updated.required = false;
          } else
            updated.schema = ['array', 'object'].includes(type.value)
              ? JSON.parse(advanced.value)
              : { type: type.value };
          if (name && name !== key.value) delete owner.properties[name];
          owner.properties[key.value] = updated;
          $('#editor').close();
          done();
        },
        'primary',
      ),
    ),
  );
}
async function proposalDialog(branch) {
  const current = await service('get_branch', { id: branch.id });
  const comparison=await service('proposal_diff',{id:branch.id});
  const node = element(
    'div',
    {},
    element('p', {}, current.name),
    table(
      ['状态', '修订', '基线'],
      [[current.state, current.revision, String(current.base_release).slice(0, 16)]],
    ),
  );
  node.append(table(['资源类型','名称','变更'],comparison.changes.map(change=>[change.kind,change.name,change.before===null?'新增':change.after===null?'移除':Object.keys(change.after).filter(key=>JSON.stringify(change.before?.[key])!==JSON.stringify(change.after[key])).join('、')])));
  const invoke = (name) => async () => {
    const result = await service(name, {
      id: current.id,
      revision: current.revision,
      ...(['review_branch', 'merge_branch'].includes(name) ? { release: current.candidate } : {}),
    });
    notice('提案已更新');
    await proposalDialog({ id: result.id });
  };
  node.append(
    element(
      'div',
      { class: 'actions' },
      button('准备候选', invoke('prepare_branch')),
      button('追赶数据', invoke('catch_up_branch')),
      button('合并主线定义', invoke('rebase_branch')),
      button('审核候选', invoke('review_branch')),
      button(
        '激活已审核发布',
        async () => {
          await invoke('merge_branch')();
          state.model = await request('/ontology?ontology=' + state.ontology);
          state.raw = null;
        },
        'primary',
      ),
    ),
  );
  node.append(
    element(
      'details',
      { class: 'section' },
      element('summary', {}, '提案定义'),
      element('pre', { class: 'code' }, JSON.stringify(current.body, null, 2)),
    ),
  );
  if ($('#editor').open) {
    $('#editor-title').textContent = '定义提案';
    $('#editor-content').replaceChildren(node);
  } else modal('定义提案', node);
}

function semanticDialog(type) {
  const embeddings = state.model.functionTypes.filter(
    (fn) => fn.version && !fn.edits && fn.returns?.type === 'array' && fn.returns.items?.type === 'number',
  );
  if (!embeddings.length) {
    modal('语义检索配置', empty('先注册并发布接收 text、返回数值向量的版本化嵌入函数，然后在这里创建索引。'));
    return;
  }
  const name = element('input', { value: type + 'Meaning' }),
    property = select(
      Object.keys(state.model.objectTypes.find((item) => item.apiName === type).properties),
      'name',
    );
  const fn = select(
      embeddings.map((item) => [item.apiName, item.apiName + ' · ' + item.version]),
      embeddings[0].apiName,
    ),
    dimensions = element('input', { type: 'number', min: '1', max: '4096', value: '384' });
  modal(
    '配置语义索引',
    element(
      'div',
      {},
      field('索引名称', name),
      field('文本属性', property),
      field('嵌入函数', fn),
      field('向量维度', dimensions),
      element(
        'div',
        { class: 'actions' },
        button('创建索引', async () => {
          await service('semantic_configure', {
            name: name.value,
            type,
            property: property.value,
            embeddingFunction: fn.value,
            dimensions: Number(dimensions.value),
          });
          notice('索引已配置');
        }),
        button('索引当前结果', async () => {
          if (!state.rows.length) throw new Error('先查询需要索引的对象');
          const result = await service('semantic_index', {
            name: name.value,
            objects: state.rows.slice(0, 100).map((item) => item.ref),
          });
          notice('已处理 ' + result.indexed + ' 个对象');
        }),
        button('检查索引', async () => {
          const status = await service('semantic_status', {
            name: name.value,
            ...(state.scenario ? { scenarioId: state.scenario } : {}),
          });
          modal('索引状态', element('pre', { class: 'code' }, JSON.stringify(status, null, 2)));
        }),
      ),
    ),
  );
}
function identityDialog(object) {
  const sources = state.model.dataSources.filter((source) => source.objectType === object.ref.type);
  if (!sources.length) throw new Error('该类型没有发布的数据源');
  const source = select(
      sources.map((source) => source.apiName),
      sources[0].apiName,
    ),
    externalId = element('input', { placeholder: '来源系统的对象 ID' }),
    reason = element('input', { placeholder: '说明这些记录代表同一个业务实体的依据' });
  modal(
    '绑定来源身份',
    element(
      'div',
      {},
      field('来源', source),
      field('来源对象 ID', externalId),
      field('绑定依据', reason),
      element('p', { class: 'subtle' }, '目标为 ' + object.ref.type + '/' + object.ref.id),
      button(
        '检查并绑定',
        async () => {
          const existing = await service('lookup_entity', {
            source: source.value,
            externalId: externalId.value,
          });
          await service('bind_entity', {
            source: source.value,
            externalId: externalId.value,
            target: object.ref,
            expectedRevision: existing.revision,
            reason: reason.value,
          });
          $('#editor').close();
          notice('来源身份已绑定，后续接入将使用此业务对象');
        },
        'primary',
      ),
    ),
  );
}
function migrationDialog() {
  const target = element('input', { placeholder: '目标本体名称' }),
    types = jsonInput({ Place: 'Place' }),
    links = jsonInput({}),
    mode = select(
      [
        ['definitions', '迁移定义'],
        ['data', '复制授权数据'],
      ],
      'definitions',
    );
  modal(
    '跨本体迁移',
    element(
      'div',
      {},
      field('迁移内容', mode),
      field('目标本体', target),
      field('对象类型映射', types),
      field('关系类型映射', links),
      button(
        '执行已配置的迁移',
        async () => {
          const typeMapping = JSON.parse(types.value),
            linkMapping = JSON.parse(links.value);
          if (mode.value === 'data') {
            const result = await service('migrate_data', {
              sourceOntology: state.ontology,
              targetOntology: target.value,
              requestId: crypto.randomUUID(),
              types: typeMapping,
              links: linkMapping,
            });
            modal('迁移记录', element('pre', { class: 'code' }, JSON.stringify(result, null, 2)));
          } else {
            const result = await service('migrate_definitions', {
              ontology: state.ontology,
              targetOntology: target.value,
              resources: Object.keys(typeMapping).map((name) => ({ kind: 'object', name })),
              mapping: { object: typeMapping, link: linkMapping },
              branchName: '迁移 ' + state.ontology + ' 定义',
            });
            modal('目标本体提案', element('pre', { class: 'code' }, JSON.stringify(result, null, 2)));
          }
        },
        'primary',
      ),
    ),
  );
}

async function openScenarioEvaluation(method, scenarios, initialSet) {
  const { scenarioEvaluation } = await import('./scenario-evaluation.js');
  return scenarioEvaluation({
    element, field, button, modal, table, jsonInput, jsonSchemaForm, stringify, select, service, model: state.model,
  }, scenarios)[method](initialSet);
}

async function renderScenarios(reviewPage = 1) {
  const [list, reviews] = await Promise.all([
    request('/ontology/scenarios?ontology=' + encodeURIComponent(state.ontology)),
    service('pending_scenario_reviews', { page: reviewPage }),
  ]);
  const holder = surface();
  const inspect = async (id) => {
    const diff = await request(
      '/ontology/scenarios/' + id + '?ontology=' + encodeURIComponent(state.ontology),
    );
    const model = element(
      'div',
      {},
      element('p', {}, diff.name),
      element('span', { class: 'badge' }, '修订 ' + diff.revision),
    );
    if (diff.review?.reviewers.length) {
      model.append(element('p', {}, '审阅人'),
        element('ul', { class: 'review-identities' }, diff.review.reviewers.map((reviewer) => element('li', {}, reviewer))));
    }
    model.append(
      table(
        ['对象', '原值', '方案值', '冲突'],
        diff.objects.map((change) => [
          change.ref.type + '/' + change.ref.id,
          stringify(change.before),
          stringify(change.after),
          change.conflict ? '需要处理' : '无',
        ]),
      ),
    );
    if (diff.links.length)
      model.append(
        table(
          ['关系', '起点', '终点', '变更', '冲突'],
          diff.links.map((link) => [
            link.type,
            link.from.id,
            link.to.id,
            link.removed ? '移除' : '添加',
            link.conflict ? '需要处理' : '无',
          ]),
        ),
      );
    model.append(
      element(
        'div',
        { class: 'actions' },
        button('在方案中探索', () => {
          state.scenario = id;
          $('#editor').close();
          navigate('objects');
        }),
        diff.review?.canInvite && button('邀请审阅', () => {
          const readers = element('textarea', { rows: '4', placeholder: '每行一个审阅身份' });
          readers.value = diff.review.reviewers.join('\n');
          $('#editor-content').replaceChildren(
            field('审阅人', readers, '审阅者可从顶栏「我的身份」复制身份。修改名单后需要审阅新的修订。'),
            button('保存审阅人', async () => {
              const reviewers = [...new Set(readers.value.split(/[\s,，]+/).filter(Boolean))];
              if (reviewers.includes(state.identity?.owner)) throw new Error('请邀请其他账户审阅。');
              if (!reviewers.length) throw new Error('请输入审阅人的身份。');
              await service('invite_scenario_reviewers', { id, revision: diff.revision, reviewers });
              await renderScenarios(reviewPage);
              await inspect(id);
              notice('已更新审阅人。');
            }, 'primary'),
            button('返回方案差异', () => inspect(id)),
          );
        }),
        button('同步正式数据', async () => {
          const result = await service('rebase_scenario', { id, revision: diff.revision });
          await renderScenarios(reviewPage);
          await inspect(id);
          notice(result.revision === diff.revision ? '方案已与正式数据同步。' : '已同步正式数据，请审阅新修订。');
        }),
        button('刷新差异', () => inspect(id)),
        button('共享元数据', () => {
          const readers = element('input', { placeholder: '读者身份，逗号分隔' });
          $('#editor-content').replaceChildren(
            field('允许查看方案元数据的读者', readers),
            button(
              '保存共享',
              async () => {
                await service('share_scenario', {
                  id,
                  revision: diff.revision,
                  readers: readers.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                });
                $('#editor').close();
                await renderScenarios();
              },
              'primary',
            ),
          );
        }),
        button(
          '通过合并操作提交',
          () => {
            state.scenario = null;
            const actions = state.model.actionTypes.filter(
              (action) =>
                action.apiName === 'CommitSchedulePlan' ||
                action.rules?.some((rule) => rule.op === 'applyScenario'),
            );
            if (!actions.length) throw new Error('请先在本体中发布限定类型范围的方案合并操作');
            const picker = select(
                actions.map((action) => action.apiName),
                actions[0].apiName,
              ),
              form = element('div');
            const draw = () => {
              const action = actions.find((action) => action.apiName === picker.value);
              const input = jsonSchemaForm(action.parameters, { scenarioId: id, revision: diff.revision });
              form.replaceChildren(
                input.node,
                button(
                  '提交已检查的方案',
                  async () => {
                    await applyAction(action.apiName, input.read(), null);
                    $('#editor').close();
                    notice('方案已合并');
                    await renderScenarios();
                  },
                  'primary',
                ),
              );
            };
            picker.onchange = draw;
            draw();
            $('#editor-content').replaceChildren(
              element('p', {}, '选择已发布的合并操作，并核对其业务参数。'),
              picker,
              form,
            );
          },
          'primary',
        ),
        button(
          '放弃方案',
          async () => {
            await request('/ontology/scenarios/' + id + '/discard', {
              revision: diff.revision,
              ontology: state.ontology,
            });
            if (state.scenario === id) state.scenario = null;
            $('#editor').close();
            await renderScenarios();
          },
          'danger',
        ),
      ),
    );
    modal('方案差异', model);
  };
  holder.append(
    list.items.length
      ? table(
          ['名称', '修订', '状态', '到期'],
          list.items.map((row) => [
            row.name,
            row.revision,
            row.state,
            new Date(row.expires_at).toLocaleString(),
          ]),
          (index) => inspect(list.items[index].id),
        )
      : empty('创建一个方案，再在方案中应用对象操作。'),
  );
  $('#main').replaceChildren(
    heading(
      '方案比较',
      '查看拟议变更，处理冲突，再通过业务操作确认合并。',
      button('接续方案',async()=>{
        const {items}=await service('scenario_continuation_sources');
        modal('接续到当前发布',items.length?table(['草稿','版本','状态',''],items.map(item=>[
          item.name,item.release.slice(0,8),item.continuation.status==='blocked'?'操作记录不完整，需要重新提案':'可尝试接续，提交时检查契约与冲突',
          item.continuation.status==='blocked'?button('查看差异并重新提案',async()=>{
            const diff=await service('inspect_scenario_continuation',{id:item.id,revision:item.revision});
            modal('旧方案恢复',element('div',{},
              element('p',{},'以下差异按当前权限显示。新方案从正式数据开始，请通过业务操作重新提出这些变更并送审。'),
              table(['对象','原值','拟议值'],diff.objects.map(change=>[
                change.ref.type+' / '+change.ref.id,stringify(change.before),stringify(change.after),
              ])),
              table(['关系','起点','终点','操作'],diff.links.map(change=>[
                change.type,change.from.id,change.to.id,change.removed?'移除':'添加',
              ])),
              button('新建方案重新提案',async()=>{
                const saved=await request('/ontology/scenarios',{ontology:state.ontology,requestId:crypto.randomUUID(),
                  name:diff.name.slice(0,180)+'（重新提案）',kind:'persisted',
                  description:`依据旧方案 ${diff.id} 修订 ${diff.revision} 重新提案，未复制旧审批或编辑。`});
                state.scenario=saved.id;
                $('#editor').close();
                await renderScenarios();
                notice('新方案已创建，请通过业务操作重新提出变更并送审');
              }),
            ));
          }):button('复制为持久方案',async()=>{
            const saved=await service('continue_scenario',{id:item.id,revision:item.revision,requestId:crypto.randomUUID()});
            state.scenario=saved.id;
            $('#editor').close();
            await renderScenarios();
          }),
        ])):empty('没有可接续或恢复的草稿。'));
      }),
      list.items.length >= 2 && button('并排比较', () => openScenarioEvaluation('compare', list.items)),
      button('离线试跑', () => openScenarioEvaluation('trial', list.items)),
      button('回到正式数据', () => {
        state.scenario = null;
        notice('已切换到正式数据');
      }),
      button(
        '创建方案',
        () => {
          const name = element('input', { placeholder: '方案名称' }),
            kind = select(
              [
                ['persisted', '保存的方案'],
                ['temporary', '当前会话临时方案'],
              ],
              'persisted',
            );
          modal(
            '创建方案',
            element(
              'div',
              {},
              field('名称', name),
              field('保存方式', kind),
              button(
                '创建',
                async () => {
                  if (kind.value === 'temporary' && !state.session) {
                    const session = await service('open_scenario_session', {});
                    state.session = session.id ?? session.sessionId;
                  }
                  const created = await request('/ontology/scenarios', {
                    ontology: state.ontology,
                    requestId: crypto.randomUUID(),
                    name: name.value,
                    kind: kind.value,
                    ...(kind.value === 'temporary' ? { sessionId: state.session } : {}),
                  });
                  state.scenario = created.id;
                  $('#editor').close();
                  notice('方案已创建，后续操作将写入此方案');
                  await renderScenarios();
                },
                'primary',
              ),
            ),
          );
        },
        'primary',
      ),
    ),
    holder,
    scenarioReviews(reviews, reviewPage, renderScenarios),
    element(
      'div',
      { class: 'toolbar' },
      state.session &&
        button('结束临时会话', async () => {
          await service('close_scenario_session', { sessionId: state.session });
          state.session = null;
          state.scenario = null;
          await renderScenarios();
        }),
      button('撤销最近的数据操作', async () => {
        const original = sessionStorage.getItem('eigos_last_action');
        if (!original) throw new Error('当前会话没有可撤销的操作');
        const result = await service('undo_action', {
          originalRequestId: original,
          requestId: crypto.randomUUID(),
        });
        notice('数据变更已补偿。外部副作用请查看原操作投递状态。');
        modal('撤销结果', element('pre', { class: 'code' }, JSON.stringify(result, null, 2)));
      }),
    ),
  );
}
function drawGraph(container, graph) {
  container.replaceChildren();
  const canvas = element('canvas'),
    labels = element('div', { class: 'graph-labels' });
  container.append(canvas, labels);
  const context = canvas.getContext('2d');
  const width = Math.max(500, container.clientWidth),
    height = 500,
    ratio = devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  context.scale(ratio, ratio);
  const positions = new Map();
  graph.nodes.forEach((object, index) => {
    const angle = index === 0 ? 0 : ((index - 1) / Math.max(1, graph.nodes.length - 1)) * Math.PI * 2;
    const position =
      index === 0
        ? [width / 2, height / 2]
        : [width / 2 + Math.cos(angle) * Math.min(width * 0.34, 320), height / 2 + Math.sin(angle) * 180];
    positions.set(JSON.stringify(object.ref), position);
    const label = button(titleOf(object), async () => {
      state.graphRoot = object.ref;
      await renderGraph();
    });
    label.style.left = position[0] + 'px';
    label.style.top = position[1] + 'px';
    label.title = object.ref.type + '/' + object.ref.id;
    labels.append(label);
  });
  context.strokeStyle = '#b7cbc1';
  context.lineWidth = 1.4;
  for (const link of graph.edges) {
    const from = positions.get(JSON.stringify(link.from)),
      to = positions.get(JSON.stringify(link.to));
    if (!from || !to) continue;
    context.beginPath();
    context.moveTo(...from);
    context.lineTo(...to);
    context.stroke();
    context.fillStyle = '#70857a';
    context.font = '10px Inter, sans-serif';
    context.fillText(link.name, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2 - 5);
  }
}
async function renderGraph() {
  const type = select(
    state.model.objectTypes.map((type) => [type.apiName, type.displayName]),
    state.graphRoot?.type ?? state.model.objectTypes[0]?.apiName,
  );
  const id = element('input', { value: state.graphRoot?.id ?? '', placeholder: '起始对象 ID' }),
    depth = select([1, 2, 3], 1);
  const diagram = element('div', { class: 'diagram' });
  const load = async () => {
    if (!id.value) {
      const page = await query({ type: type.value, limit: 1 });
      if (!page.items.length) {
        diagram.replaceChildren(empty('当前类型没有对象。'));
        return;
      }
      id.value = page.items[0].ref.id;
    }
    state.graphRoot = { type: type.value, id: id.value };
    const graph = await service('explore_graph', {
      object: state.graphRoot,
      depth: Number(depth.value),
      ...(state.scenario ? { scenarioId: state.scenario } : {}),
    });
    drawGraph(diagram, graph);
  };
  $('#main').replaceChildren(
    heading(
      '关系与模拟',
      '从业务对象展开关联，在隔离方案中执行操作并比较计算结果。',
      button('创建模拟方案', async () => {
        const created = await request('/ontology/scenarios', {
          ontology: state.ontology,
          requestId: crypto.randomUUID(),
          name: '图谱模拟 ' + new Date().toLocaleTimeString(),
        });
        state.scenario = created.id;
        notice('模拟方案已创建');
      }),
      button('执行方案操作', () => actionDialog({ ref: state.graphRoot })),
    ),
    element(
      'div',
      { class: 'toolbar' },
      type,
      id,
      field('关系深度', depth),
      button('展开关系', load, 'primary'),
      button('比较计算', () => {
        const functions = state.model.functionTypes.filter((fn) => !fn.edits && !fn.source);
        if (!functions.length) throw new Error('没有可用于比较的对象计算函数');
        const picker = select(
            functions.map((fn) => fn.apiName),
            functions[0].apiName,
          ),
          holder = element('div');
        const redraw = () => {
          const fn = functions.find((fn) => fn.apiName === picker.value),
            form = jsonSchemaForm(fn.parameters);
          holder.replaceChildren(
            form.node,
            button(
              '计算正式与方案结果',
              async () => {
                const input = form.read();
                const live = await request('/ontology/functions', {
                  ontology: state.ontology,
                  function: fn.apiName,
                  input,
                });
                const proposed = state.scenario
                  ? await request('/ontology/functions', {
                      ontology: state.ontology,
                      function: fn.apiName,
                      input,
                      scenarioId: state.scenario,
                    })
                  : null;
                modal(
                  '计算比较',
                  element(
                    'div',
                    { class: 'two' },
                    surface(
                      element(
                        'div',
                        { class: 'detail' },
                        element('h3', {}, '正式数据'),
                        element('pre', { class: 'code' }, JSON.stringify(live, null, 2)),
                      ),
                    ),
                    surface(
                      element(
                        'div',
                        { class: 'detail' },
                        element('h3', {}, '当前方案'),
                        element(
                          'pre',
                          { class: 'code' },
                          proposed === null ? '请先创建方案' : JSON.stringify(proposed, null, 2),
                        ),
                      ),
                    ),
                  ),
                );
              },
              'primary',
            ),
          );
        };
        picker.onchange = redraw;
        redraw();
        modal('选择模拟函数', element('div', {}, picker, holder));
      }),
    ),
    surface(
      diagram,
      element('div', { class: 'legend' }, '点击节点可继续展开。图中仅显示当前身份可读取的对象。'),
    ),
  );
  await load();
}
async function renderSchedule() {
  const page = await query({ type: 'SchedulePlan', limit: 100 });
  const plans = page.items,
    chosen = plans.find((item) => item.ref.id === state.planId) ?? plans[0];
  const selector = select(
    plans.map((plan) => [plan.ref.id, titleOf(plan)]),
    chosen?.ref.id,
    (value) => {
      state.planId = value;
      renderSchedule();
    },
  );
  const panel = surface();
  $('#main').replaceChildren(
    heading(
      '排程',
      '依据已提供的忙闲信息与依赖约束比较安排，确认后提交内部计划。',
      button('创建计划', () => {
        const form = jsonSchemaForm(
          state.model.actionTypes.find((action) => action.apiName === 'PrepareSchedulePlan').parameters,
          {
            title: '新的安排',
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            durationMinutes: 30,
          },
        );
        modal(
          '请求日历支持的排程',
          element(
            'div',
            {},
            form.node,
            button(
              '提交原 PA 任务',
              async () => {
                const input = form.read();
                const task = await request('/tasks', {
                  requestId: crypto.randomUUID(),
                  message: '请根据我的日历忙闲创建内部排程计划，参数为 ' + JSON.stringify(input),
                });
                $('#editor').close();
                notice('任务已提交。需要日历信息时会在流程运行中显示。');
                state.taskId = task.id;
                navigate('processes');
              },
              'primary',
            ),
          ),
        );
      }),
    ),
    element(
      'div',
      { class: 'toolbar' },
      selector,
      button('查看当前方案', () => navigate('scenarios')),
      button('回到正式排程', () => {
        state.scenario = null;
        renderSchedule();
      }),
    ),
    panel,
  );
  if (!chosen) {
    panel.append(empty('还没有可读取的计划。创建计划并由 PA 提供日历忙闲信息。'));
    return;
  }
  state.planId = chosen.ref.id;
  let data;
  try {
    data = await request('/ontology/functions', {
      ontology: state.ontology,
      function: 'readSchedulePlan',
      input: { plan: chosen.ref },
      ...(state.scenario ? { scenarioId: state.scenario } : {}),
    });
  } catch (error) {
    const activities = await relatedObjects(chosen.ref, 'activities');
    data = {
      plan: chosen,
      activities: activities.items,
      validation: {valid:false,evaluatedAt:null,unavailable:true,violations:[]},
    };
    panel.append(
      element('div', { class: 'error' }, error.message),
      button('刷新日历并创建重规划方案', async () => {
        const scenario = await request('/ontology/scenarios', {
          ontology: state.ontology,
          requestId: crypto.randomUUID(),
          name: '重规划 ' + titleOf(chosen),
        });
        state.scenario = scenario.id;
        const parameters = {
          title: chosen.properties.name,
          start: chosen.properties.start,
          end: chosen.properties.end,
          timeZone: chosen.properties.timeZone,
          durationMinutes: chosen.properties.durationMinutes,
          plan: chosen.ref,
          scenarioId: scenario.id,
        };
        const task = await request('/tasks', {
          requestId: crypto.randomUUID(),
          message: '请向原 PA 重新读取日历，并在指定方案内重规划已有计划。参数 ' + JSON.stringify(parameters),
        });
        state.taskId = task.id;
        navigate('processes');
      }),
    );
  }
  const start = Date.parse(data.plan.properties.start),
    end = Date.parse(data.plan.properties.end),
    duration = end - start;
  const grid = element('div', { class: 'calendar-grid' });
  grid.append(
    element('div', { class: 'calendar-label' }, new Date(start).toLocaleDateString()),
    element(
      'div',
      { class: 'calendar-label' },
      new Date(start).toLocaleTimeString() + ' — ' + new Date(end).toLocaleString(),
    ),
  );
  for (const activity of data.activities) {
    const timeline = element('div', { class: 'timeline' }),
      block = element('button', { class: 'activity', title: '拖动以在方案中调整时间' }, titleOf(activity));
    block.style.left = Math.max(0, ((Date.parse(activity.properties.start) - start) / duration) * 100) + '%';
    block.style.width =
      Math.max(
        5,
        ((Date.parse(activity.properties.end) - Date.parse(activity.properties.start)) / duration) * 100,
      ) + '%';
    block.onpointerdown = (event) => {
      const x = event.clientX;
      block.setPointerCapture(event.pointerId);
      block.onpointerup = async (up) => {
        block.onpointerup = null;
        const delta = Math.round((((up.clientX - x) / timeline.clientWidth) * duration) / 300000) * 300000;
        if (!delta) return;
        try {
          if (!state.scenario) {
            const scenario = await request('/ontology/scenarios', {
              ontology: state.ontology,
              requestId: crypto.randomUUID(),
              name: '调整 ' + titleOf(chosen),
            });
            state.scenario = scenario.id;
          }
          // The Action replaces the full predecessor list, so a partial read must not be saved.
          const predecessors = (await relatedObjects(activity.ref, 'predecessors', { complete: true })).items;
          const idValue = activity.ref.id;
          const form = jsonSchemaForm(
            state.model.actionTypes.find((action) => action.apiName === 'SaveScheduleActivity').parameters,
            {
              plan: chosen.ref,
              activity: activity.ref,
              id: idValue,
              name: activity.properties.name,
              revision: activity.revision,
              start: new Date(Date.parse(activity.properties.start) + delta).toISOString(),
              end: new Date(Date.parse(activity.properties.end) + delta).toISOString(),
              predecessors: predecessors.map((item) => item.ref),
            },
          );
          modal(
            '确认调整到方案',
            element(
              'div',
              {},
              form.node,
              button(
                '保存方案调整',
                async () => {
                  await applyAction('SaveScheduleActivity', form.read());
                  $('#editor').close();
                  await renderSchedule();
                },
                'primary',
              ),
            ),
          );
        } catch (error) {
          notice(error.message, true);
        }
      };
    };
    timeline.append(block);
    grid.append(element('div', { class: 'calendar-label' }, titleOf(activity)), timeline);
  }
  panel.append(
    grid,
    element(
      'div',
      { class: 'detail' },
      element(
        'span',
        { class: 'badge ' + (data.validation.valid ? '' : 'warning') },
        data.validation.unavailable?'待刷新日历':data.validation.valid ? '当前约束通过' : '存在约束冲突',
      ),
      element('p', { class: 'subtle' }, data.validation.evaluatedAt?'校验于 '+new Date(data.validation.evaluatedAt).toLocaleString():'刷新日历后重新校验'),
      data.validation.violations.length
        ? table(
            ['活动', '约束'],
            data.validation.violations.map((item) => [item.activity.id, item.code]),
          )
        : null,
      element(
        'div',
        { class: 'actions' },
        data.activities.length > 0 && state.model.functionTypes.some(fn => fn.apiName === 'recommendSchedule') &&
          button('联合优化时段', () => {
            const choices = data.activities.map(activity=>({activity, checkbox:element('input',{type:'checkbox'})}));
            const objective = select([['minimum_displacement','最少改动'],['earliest_finish','最早完成']], 'minimum_displacement');
            const output = element('div');
            modal('排程优化', element('div', {},
              field('目标',objective),
              choices.map(({activity,checkbox})=>element('label',{class:'toolbar'},checkbox,titleOf(activity))),
              button('计算建议',async()=>{
                const selected=choices.filter(item=>item.checkbox.checked).map(item=>item.activity.ref);
                if(!selected.length||selected.length>12)throw new Error('请选择 1–12 个活动');
                const scenarioId=state.scenario;
                const recommendation=await request('/ontology/functions',{ontology:state.ontology,function:'recommendSchedule',
                  input:{plan:chosen.ref,activities:selected,objective:objective.value},...(scenarioId?{scenarioId}:{})});
                const labels={optimal:'已找到最优时段',feasible:'达到搜索上限，已找到可行时段',
                  infeasible:'当前网格没有可行时段',search_limit:'达到搜索上限，未找到可行时段'};
                output.replaceChildren(element('p',{},labels[recommendation.status]),
                  recommendation.moves.length>0&&table(['活动','开始','结束'],recommendation.moves.map(move=>[
                    titleOf(data.activities.find(item=>item.ref.id===move.activity.id)),
                    new Date(move.start).toLocaleString(),new Date(move.end).toLocaleString(),
                  ])),
                  recommendation.moves.length>0&&button('写入方案',async()=>{
                    if(state.scenario!==scenarioId)throw new Error('当前方案已切换。请重新计算建议。');
                    if(!scenarioId){
                      const created=await request('/ontology/scenarios',{ontology:state.ontology,requestId:crypto.randomUUID(),name:'优化 '+titleOf(chosen)});
                      state.scenario=created.id;
                    }
                    await applyAction('StageScheduleRecommendation',{plan:chosen.ref,moves:recommendation.moves});
                    $('#editor').close();
                    await renderSchedule();
                  }),
                );
              }),output));
          }),
        button('查找可用时段', async () => {
          const result = await request('/ontology/functions', {
            ontology: state.ontology,
            function: 'findScheduleSlots',
            input: { plan: chosen.ref },
            ...(state.scenario ? { scenarioId: state.scenario } : {}),
          });
          modal(
            '可用时段',
            result.slots.length
              ? table(
                  ['开始', '结束', ''],
                  result.slots.map((slot) => [
                    new Date(slot.start).toLocaleString(),
                    new Date(slot.end).toLocaleString(),
                    button('安排到方案', async () => {
                      if (!state.scenario) {
                        const created = await request('/ontology/scenarios', {
                          ontology: state.ontology,
                          requestId: crypto.randomUUID(),
                          name: '安排 ' + titleOf(chosen),
                        });
                        state.scenario = created.id;
                      }
                      await applyAction('SaveScheduleActivity', {
                        plan: chosen.ref,
                        id: crypto.randomUUID(),
                        name: '新活动',
                        ...slot,
                      });
                      $('#editor').close();
                      await renderSchedule();
                    }),
                  ]),
                )
              : empty('在当前约束下没有可用时段。'),
          );
        }),
        button(
          '确认当前方案',
          async () => {
            if (!state.scenario) throw new Error('请先创建或选择排程方案');
            const diff = await request('/ontology/scenarios/' + state.scenario + '?ontology=' + encodeURIComponent(state.ontology));
            await applyAction(
              'CommitSchedulePlan',
              { plan: chosen.ref, scenarioId: state.scenario, revision: diff.revision },
              null,
            );
            state.scenario = null;
            notice('内部排程已确认');
            await renderSchedule();
          },
          'primary',
        ),
      ),
    ),
  );
}
async function renderPublishedWorkflows() {
  const [published,runs] = await Promise.all([service('published_workflows'),service('workflow_runs')]);
  const open = async workflow => {
    const outcome = element('div');
    const input = select([['','选择对象']], '');
    async function load(cursor) {
      const result = await query({type:workflow.targetType,limit:30,...(cursor?{cursor}:{})});
      input.replaceChildren(...select([['','选择对象'],...result.items.map(item =>
        [item.ref.id,item.properties.name ?? item.ref.id])], '').children);
      outcome.replaceChildren(result.cursor ? button('下一页对象',()=>load(result.cursor)) : null);
    }
    await load();
    modal(workflow.name, element('div', {},
      workflow.description && element('p',{},workflow.description),
      field('运行对象',input),outcome,
      button('运行流程',async()=>{
        if (!input.value) throw new Error('请选择运行对象');
        const result=await service('run_published_workflow',{workflow:workflow.id,revision:workflow.revision,
          object:{type:workflow.targetType,id:input.value},requestId:crypto.randomUUID()});
        $('#editor').close();
        notice('流程已提交 · '+result.id);
        await renderPublishedWorkflows();
      },'primary')));
  };
  const label = {pending:'待执行',working:'执行中',completed:'已完成',failed:'失败',canceled:'已取消',
    'waiting-proposal':'等待生成方案','waiting-approval':'等待审核'};
  $('#main').replaceChildren(
    heading('已发布流程','选择流程和你有权使用的对象。',button('刷新',renderPublishedWorkflows)),
    surface(published.items.length ? table(['流程','说明',''],published.items.map(item=>[
      item.name,item.description,button('运行',()=>open(item)),
    ])) : empty('暂无可用的已发布流程。')),
    element('section',{class:'section'},element('h2',{},'我的运行'),
      surface(runs.items.length ? table(['流程','状态','进度'],runs.items.map(run=>[
        run.name,label[run.state]??run.state,run.step+' / '+run.stepCount,
      ])) : empty('暂无流程运行。'))));
}
function workflowPublication(workflow) {
  const type=select(state.model.objectTypes.map(item=>item.apiName),workflow.publication?.targetType);
  modal('发布流程',element('div',{},
    field('运行对象类型',type),
    button('发布此修订',async()=>{
      await service('publish_workflow',{id:workflow.id,revision:Number(workflow.revision),targetType:type.value});
      $('#editor').close();
      await renderRules();
    },'primary')));
}
async function renderRules() {
  const [workflows, rules] = await Promise.all([service('workflows'), service('rules')]);
  const panel = surface(
    rules.items.length
      ? table(
          ['规则', '触发条件', '状态', '最近检查', ''],
          rules.items.map((rule) => {
            const process = rule.process;
            const condition = process
              ? process.type + ' · ' + (process.from === null ? '空' : process.from ?? '任意') +
                ' → ' + (process.to ?? '任意') + (process.dwellSeconds ? ' · ' + process.dwellSeconds + ' 秒' : '')
              : rule.query.type;
            return [
              rule.name,
              condition,
              rule.enabled ? '监测中' : '已停用',
              rule.error || (rule.lastScan ? new Date(rule.lastScan).toLocaleString() : '尚未检查'),
              element('div',{class:'actions'},
              button(rule.enabled ? '停用' : '启用', async () => {
                const { lastScan, error, ...input } = rule;
                await service('save_rule', { ...input, enabled: !rule.enabled });
                await renderRules();
              }),
                !rule.machineryReview&&button('预演',async()=>{
                  const list=await request('/ontology/scenarios?ontology='+encodeURIComponent(state.ontology));
                  const choices=list.items.map(row=>({row,checkbox:element('input',{type:'checkbox'})}));
                  const elapsed=element('input',{type:'number',min:0,value:0});
                  const results=element('div');
                  modal('自动化预演',element('div',{},
                    choices.map(({row,checkbox})=>element('label',{class:'toolbar'},checkbox,row.name)),
                    field('模拟经过的秒数',elapsed),
                    button('运行预演',async()=>{
                      const scenarios=choices.filter(item=>item.checkbox.checked).map(({row})=>({id:row.id,revision:Number(row.revision)}));
                      const report=await service('preview_automation',{rule:rule.id,revision:Number(rule.revision),scenarios,elapsedSeconds:Number(elapsed.value)});
                      results.replaceChildren(table(['方案','匹配且执行','仍在等待'],report.scenarios.map(item=>[
                        item.name,item.results.length,item.waiting.length])),
                      element('pre',{class:'code'},JSON.stringify(report.scenarios,null,2)));
                    }),results));
                }),
              ),
            ];
          }),
        )
      : empty('创建规则并显式启用后，符合条件的新对象状态会触发流程。'),
  );
  const makeWorkflow = () => {
    const name = element('input', { placeholder: '流程名称' }),
      proposal = element('textarea', { spellcheck: false, rows: 7 }),
      steps = [],
      list = element('div', { class: 'list' });
    const addStep = () => {
      const action = select(
        state.model.actionTypes.map((action) => action.apiName),
        state.model.actionTypes[0]?.apiName,
      );
      const fields = element('div'),
        item = { action, read: () => ({}) };
      steps.push(item);
      const draw = () => {
        const definition = state.model.actionTypes.find((item) => item.apiName === action.value),
          bindings = [];
        fields.replaceChildren();
        for (const [key, schema] of Object.entries(definition.parameters.properties ?? {})) {
          const mode = select(
            [
              ['literal', '固定值'],
              ['object', '触发对象'],
              ['property', '对象属性'],
              ['revision', '当前修订号'],
            ],
            definition.objectParameters[key] ? 'object' : 'literal',
          );
          const input = element('div'),
            property = element('input', { value: key, placeholder: '属性名，例如 name' }),
            literal = jsonSchemaForm({
              properties: { value: schema },
              required: definition.parameters.required?.includes(key) ? ['value'] : [],
            });
          const update = () =>
            input.replaceChildren(
              mode.value === 'literal'
                ? literal.node
                : mode.value === 'property'
                  ? property
                  : element(
                      'p',
                      { class: 'subtle' },
                      mode.value === 'object'
                        ? '使用触发此流程的对象引用。'
                        : '使用执行此步骤时的对象修订号。',
                    ),
            );
          mode.onchange = update;
          update();
          fields.append(field(key, element('div', {}, mode, input)));
          bindings.push({ key, mode, property, literal });
        }
        item.read = () =>
          Object.fromEntries(
            bindings.flatMap((binding) => {
              if (binding.mode.value === 'object') return [[binding.key, { object: true }]];
              if (binding.mode.value === 'property')
                return [[binding.key, { property: binding.property.value }]];
              if (binding.mode.value === 'revision') return [[binding.key, { property: '$revision' }]];
              const value = binding.literal.read().value;
              return value === undefined ? [] : [[binding.key, { literal: value }]];
            }),
          );
      };
      action.onchange = draw;
      draw();
      const card = surface(element('div', { class: 'detail' },
        field('操作', action), fields, button('移除此步骤', () => {
          steps.splice(steps.indexOf(item), 1);
          card.remove();
        }),
      ));
      list.append(card);
    };
    addStep();
    modal(
      '创建流程',
      element(
        'div',
        {},
        field('名称', name),
        list,
        button('添加步骤', addStep),
        element('details', {},
          element('summary', {}, 'Scenario 认知提案'),
          field('提案配置 JSON', proposal,
            '填写 name、goal、actions、functions、validation、mergeAction、mergeObjectParameter 和 reviewers。留空时只执行上面的 Action 步骤。'),
        ),
        button(
          '保存流程',
          async () => {
            await service('save_workflow', {
              name: name.value,
              ...(proposal.value.trim() ? { proposal: JSON.parse(proposal.value) } : {}),
              steps: steps.map((item, index) => ({
                name: 'Step' + (index + 1),
                action: item.action.value,
                input: item.read(),
              })),
            });
            $('#editor').close();
            await renderRules();
          },
          'primary',
        ),
      ),
    );
  };
  const actionWorkflows = workflows.items.filter((item) => Array.isArray(item.steps) && item.kind !== 'learned-hotel-itinerary');
  $('#main').replaceChildren(
    heading(
      '规则与监测',
      '监测对象匹配、状态转换或状态停留时间。',
      button('创建流程', makeWorkflow),
      button(
        '创建规则',
        () => {
          if (!actionWorkflows.length) throw new Error('请先创建一个可由规则触发的流程');
          const name = element('input', { placeholder: '规则名称' }),
            type = select(
              state.model.objectTypes.map((type) => type.apiName),
              state.model.objectTypes[0].apiName,
            ),
            property = element('input', { placeholder: '属性名' }),
            value = element('input', { placeholder: '匹配值' }),
            workflow = select(
              actionWorkflows.map((item) => [item.id, item.name]),
              actionWorkflows[0].id,
            );
          const processes = state.model.objectTypes.flatMap((log) => {
            const target = log.typeClasses?.find((item) => item.kind === 'machinery-log')?.name;
            const property = log.typeClasses?.find((item) => item.kind === 'machinery-property')?.name;
            const model = state.model.objectTypes.find((item) => item.apiName === target);
            const states = model?.properties[property]?.schema?.enum;
            return Array.isArray(states) ? [{ type: log.apiName, states }] : [];
          });
          const mode = select([['query', '对象匹配'], ...(processes.length ? [['process', '状态转换']] : [])], 'query');
          const query = element('div', {}, field('对象类型', type), field('属性', property), field('匹配值', value));
          const log = select(processes.map((process) => process.type), processes[0]?.type);
          const from = element('select'), to = element('select');
          const dwell = element('input', { type: 'number', min: 1, max: 2678400, placeholder: '留空则立即触发' });
          const process = element('div', { hidden: true },
            field('过程日志', log), field('原状态', from), field('目标状态', to), field('停留秒数', dwell));
          log.onchange = () => {
            const states = processes.find((item) => item.type === log.value)?.states ?? [];
            const options = states.map((state) => [JSON.stringify(state), state]);
            from.replaceChildren(...select([['', '任意'], ['null', '空'], ...options], '').children);
            to.replaceChildren(...select([['', '任意'], ...options], '').children);
          };
          log.onchange();
          mode.onchange = () => {
            query.hidden = mode.value !== 'query';
            process.hidden = mode.value !== 'process';
          };
          modal(
            '创建监测规则',
            element(
              'div',
              {},
              field('名称', name),
              field('触发方式', mode),
              query,
              process,
              field('触发流程', workflow),
              button(
                '保存为停用状态',
                async () => {
                  await service('save_rule', {
                    name: name.value,
                    ...(mode.value === 'process' ? {
                      process: {
                        type: log.value,
                        ...(from.value ? { from: JSON.parse(from.value) } : {}),
                        ...(to.value ? { to: JSON.parse(to.value) } : {}),
                        ...(dwell.value ? { dwellSeconds: Number(dwell.value) } : {}),
                      },
                    } : {
                      query: { type: type.value, where: property.value ? { [property.value]: value.value } : {} },
                    }),
                    workflow: workflow.value,
                    enabled: false,
                  });
                  $('#editor').close();
                  await renderRules();
                },
                'primary',
              ),
            ),
          );
        },
        'primary',
      ),
    ),
    panel,
    element(
      'div',
      { class: 'section' },
      element('h2', {}, '可运行流程'),
      surface(
        workflows.items.length
          ? table(
              ['名称', '步骤', '发布', ''],
              workflows.items.map((workflow) => [
                workflow.name,
                workflow.kind === 'learned-hotel-itinerary' ? '酒店行程 · 每次模拟前审批' : workflow.steps.map((step) => step.action).join(' → '),
                state.membership?.canPublishWorkflows && workflow.kind !== 'learned-hotel-itinerary' &&
                  element('div',{class:'actions'},
                    button('发布',()=>workflowPublication(workflow)),
                    workflow.publication && button('下架',async()=>{
                      await service('withdraw_workflow',{id:workflow.id,revision:workflow.publication.revision});
                      await renderRules();
                    })),
                button('运行', () => {
                  if (workflow.kind === 'learned-hotel-itinerary') {
                    const checkIn = element('input', { type: 'date', required: true });
                    modal('复用酒店行程', element('div', {},
                      field('入住日期', checkIn),
                      button('生成待审核方案', async () => {
                        if (!checkIn.value) throw new Error('请选择入住日期');
                        await request('/tasks', {
                          requestId: crypto.randomUUID(), message: '复用酒店行程',
                          replayHotelWorkflow: { workflowId: workflow.id, checkIn: checkIn.value },
                        });
                        $('#editor').close();
                        navigate('processes');
                      }, 'primary'),
                    ));
                    return;
                  }
                  const form = jsonSchemaForm({
                    properties: { type: { type: 'string' }, id: { type: 'string' } },
                    required: ['type', 'id'],
                  });
                  modal(
                    '选择流程对象',
                    element(
                      'div',
                      {},
                      form.node,
                      button(
                        '运行流程',
                        async () => {
                          await service('run_workflow', {
                            workflow: workflow.id,
                            object: form.read(),
                            requestId: crypto.randomUUID(),
                          });
                          $('#editor').close();
                          navigate('processes');
                        },
                        'primary',
                      ),
                    ),
                  );
                }),
              ]),
            )
          : empty('流程由已发布的 Action 组成。'),
      ),
    ),
  );
}
function transferDecisionReview(memory) {
  const fields = [
    ['reason', '选择这个接驳时段的理由'],
    ['alternative', '考虑过的备选'],
    ['rejectedBecause', '放弃备选的原因'],
    ['assumption', '需要实测核对的假设'],
  ].map(([key, label]) => ({ key, label, input: element('textarea', { rows: '2', maxlength: '1000' }) }));
  const travel = element('input', { type: 'number', min: '1', max: '240', step: '1' });
  const assessment = { supported: '得到支持', refuted: '被推翻', insufficient: '证据不足' };
  const arrival = (minutes) => (minutes < 0 ? '晚到 ' : '提前 ') + Math.abs(minutes) + ' 分钟';
  return {
    node: element('section', { class: 'section' },
      element('h3', {}, '酒店接驳决策（合成）'),
      element('p', {}, '出发 ' + memory.departure + '，最晚抵达 ' + memory.arriveBy),
      ...memory.prior.map((item) => element('section', { class: 'surface' },
        element('h4', {}, item.date + ' 的接驳复盘（合成）'),
        element('p', {}, '当时的理由 ' + item.judgment.reason),
        element('p', {}, '备选与取舍 ' + item.judgment.alternative + '，' + item.judgment.rejectedBecause),
        element('p', {}, '假设 ' + item.judgment.assumption + '（' + assessment[item.assessment] + '）'),
        element('p', {}, '预计' + arrival(item.expectedBufferMinutes) + '，实测' +
          arrival(item.actualBufferMinutes) + '（车程 ' + item.actualTravelMinutes + ' 分钟）'),
        element('p', {}, '教训 ' + item.lesson),
        element('p', {}, '适用条件 ' + item.appliesWhen),
      )),
      ...fields.map(({ label, input }) => field(label, input)),
      field('预计车程（分钟）', travel),
    ),
    read() {
      const expectedTravelMinutes = Number(travel.value);
      if (!Number.isInteger(expectedTravelMinutes) || expectedTravelMinutes < 1 || expectedTravelMinutes > 240 ||
          fields.some(({ input }) => !input.value.trim())) {
        throw new Error('请填写本次理由、备选、假设和预计车程。');
      }
      return { ...Object.fromEntries(fields.map(({ key, input }) => [key, input.value.trim()])), expectedTravelMinutes };
    },
  };
}

function scenarioReviews(reviews, page, refresh) {
  const inspectReview = async (item) => {
    const review = await service('inspect_scenario_review', { id: item.id });
    const ref = ({ type, id }) => type + ' · ' + id;
    const changes = review.objects.flatMap((object) =>
      object.editedFields.map((field) => [
        ref(object.ref), field, stringify(object.before?.[field]), stringify(object.after?.[field]),
      ]),
    );
    const blocked = review.evidenceChanged
      ? '决策证据已变化。需要重新生成提案。'
      : review.conflicts ? '方案存在冲突。需要处理冲突后重新审阅。' : '';
    const decision = review.decisionMemory && transferDecisionReview(review.decisionMemory);
    modal(review.name, element('div', {},
      element('p', {}, '方案第 ' + review.revision + ' 版'),
      blocked && element('p', {}, blocked),
      review.evidenceVersion && element('p', {}, '决策版本 ' + review.evidenceVersion.slice(0, 12)),
      changes.length > 0 && table(['对象', '字段', '原值', '拟议值'], changes),
      review.links.length > 0 && table(['关系', '起点', '终点', '变更'],
        review.links.map((link) => [link.type, ref(link.from), ref(link.to), link.removed ? '移除' : '新增'])),
      !review.evidenceChanged && (review.evidence?.length ?? 0) > 0 && table(['证据对象', '修订号'],
        review.evidence.map((entry) => [ref(entry.ref), entry.revision])),
      review.commit && element('div', { class: 'section' },
        element('h3', {}, '合并 Action 与外发内容'),
        element('pre', { class: 'code' }, JSON.stringify(review.commit, null, 2)),
      ),
      decision && decision.node,
      !review.conflicts && button('批准此版本', async () => {
        await service('approve_scenario_review', {
          id: review.id, revision: review.revision, snapshot: review.snapshot,
          ...(decision && !item.approved ? { decision: decision.read() } : {}),
        });
        $('#editor').close();
        await refresh(page);
        notice('已批准此修订。');
      }, 'primary'),
    ));
  };
  return element('section', { class: 'section' },
    element('h2', {}, '受邀审阅'),
    surface(reviews.items.length
      ? table(['方案', '版本', '状态'], reviews.items.map((review) => [
          review.name, review.revision, review.approved ? '已批准' : review.conflicts ? '需处理冲突' : '待审阅',
        ]), (index) => inspectReview(reviews.items[index]))
      : empty('这一页没有可审阅的方案。')),
    page > 1 && button('上一页', () => refresh(page - 1)),
    reviews.nextPage && button('下一页', () => refresh(reviews.nextPage)),
  );
}

async function renderProcesses(reviewPage = 1) {
  if (typeof reviewPage !== 'number') reviewPage = 1;
  const [tasks, workflows, reviews] = await Promise.all([
    service('tasks'), service('workflow_runs'), service('pending_scenario_reviews', { page: reviewPage }),
  ]);
  const inspect = (task) => {
    const locationRequest = task.state === 'input-required' && task.result?.kind === 'pa-request' && task.result.capability === 'location.resolve';
    const body = element('div', {}, !locationRequest && element('p', {}, task.state + (task.error ? ' · ' + task.error : '')));
    if (task.state === 'input-required' && ['city', 'origin', 'destination'].includes(task.result?.kind)) {
      const kind = task.result.kind;
      const title = ({ city: '城市', origin: '上车点', destination: '目的地' })[kind];
      const field = kind === 'city' ? 'city' : 'place';
      const form = jsonSchemaForm({ properties: { [field]: { type: 'string', title } }, required: [field] });
      body.append(form.node, button('确认' + title, async () => {
        await request('/tasks/' + task.id + '/input', { answer: { kind, ...form.read() } });
        $('#editor').close();
        await renderProcesses();
      }, 'primary'));
    }
    const review = task.result?.hotelWorkflow;
    if (review?.status === 'awaiting_approval') {
      const hotel = task.result.hotel.properties;
      const route = task.result.route.travel.properties;
      const activity = task.result.activities[0].properties;
      const format = (time) => new Date(time).toLocaleString('zh-CN', { timeZone: task.result.plan.properties.timeZone });
      body.append(
        element('h3', {}, '审核酒店行程'),
        element('p', {}, hotel.name + ' · ' + review.checkIn + ' · ' + hotel.currency + ' ' + (hotel.amount ?? '参考价不可用')),
        element('p', {}, task.result.route.origin.properties.name + ' → ' + task.result.route.destination.properties.name),
        element('p', {}, format(activity.start) + ' — ' + format(activity.end) + ' · 车程约 ' + Math.ceil(route.durationSeconds / 60) + ' 分钟'),
        element('p', {}, '方案第 ' + review.revision + ' 版 · ' +
          (task.result.validation.calendarEvidence.some((item) => item.evidence === 'synthetic') ? '测试日历' : 'PA 日历')),
        button('批准本次模拟执行', async () => {
          await request('/tasks/' + task.id + '/hotel-simulation-approval', {
            scenarioId: review.scenarioId, revision: review.revision, snapshot: review.snapshot, decision: 'approve-simulation',
          });
          $('#editor').close();
          await renderProcesses();
        }, 'primary'),
      );
    } else if (review?.status === 'simulated') {
      body.append(element('p', {}, '模拟完成 · 已保存可复用流程 ' + review.workflowId));
    }

    if (task.state === 'input-required' && task.result?.kind === 'pa-request') {
      const requestData = task.result;
      if (locationRequest) {
        const { selection, use, coordinateSystem } = requestData.input;
        const share = async (response) => {
          await request('/tasks/' + task.id + '/pa-response', { requestId: requestData.requestId, response });
          $('#editor').close();
          await renderProcesses();
        };
        const serviceName = ({
          waimai_delivery: '美团外卖', luckin_pickup: '瑞幸', nearby_search: '高德周边搜索',
          map_route: '高德路线查询', weather: '高德天气', ride_pickup: '叫车上车点查询',
        })[use];
        const submitPlace = async (form, requiredPlace) => {
          const { place = requiredPlace, ...point } = form.read();
          await share({
            status: 'available', location: { source: selection.source === 'current' ? 'specified' : selection.source,
              place, coordinateSystem, ...point },
          });
        };
        body.append(
          element('h3', {}, '本次查询位置'),
          element('p', {}, (serviceName || '本次服务') + '会使用你此次提供的位置。'),
          use === 'waimai_delivery' && requestData.input.coordinateProvider === 'Amap'
            ? element('p', {}, '高德地图将转换设备坐标供美团外卖使用。') : null,
          use === 'ride_pickup' && element('p', {}, '高德地图将把设备坐标转换为 GCJ-02，供你核对上车地址。'),
        );
        if (selection.source === 'current' && (coordinateSystem === 'wgs84' || requestData.input.acceptDeviceWgs84)) {
          body.append(button('共享本机当前位置', async () => {
            const { currentTaskLocation } = await import('./task-location.js');
            await share(await currentTaskLocation(navigator.geolocation, requestData.input));
          }, 'primary'));
        }
        const coordinateLabel = coordinateSystem === 'gcj02' ? '高德坐标（GCJ-02）' : '设备坐标（WGS84）';
        const placeForm = jsonSchemaForm({
          properties: {
            ...(selection.source === 'current' ? { place: { type: 'string', title: '地点名称' } } : {}),
            latitude: { type: 'number', title: '纬度', minimum: -90, maximum: 90 },
            longitude: { type: 'number', title: '经度', minimum: -180, maximum: 180 },
          },
          required: ['latitude', 'longitude', ...(selection.source === 'current' ? ['place'] : [])],
        });
        body.append(element('details', { class: 'section' },
          element('summary', {}, selection.source === 'current' ? '改用指定地点' : '为「' + selection.place + '」提供' + coordinateLabel),
          element('p', {}, '填写' + coordinateLabel + '。'),
          placeForm.node,
          button('使用此地点', async () => submitPlace(placeForm, selection.place)),
        ));
        body.append(button('暂不提供', async () => share({ status: 'declined' })));
      } else if (requestData.capability === 'calendar.freebusy') {
        const busyRows = [],
          ranges = element('div', { class: 'list' }),
          complete = element('input', { type: 'checkbox' });
        const addBusy = () => {
          const form = jsonSchemaForm({
            properties: {
              start: { type: 'string', format: 'date-time' },
              end: { type: 'string', format: 'date-time' },
            },
            required: ['start', 'end'],
          });
          busyRows.push(form);
          ranges.append(surface(element('div', { class: 'detail' }, form.node)));
        };
        body.append(
          element('h3', {}, '提供日历忙闲信息'),
          element(
            'p',
            {},
            new Date(requestData.input.start).toLocaleString() +
              ' — ' +
              new Date(requestData.input.end).toLocaleString(),
          ),
          ranges,
          button('添加忙碌时间', addBusy),
          element(
            'label',
            { class: 'check section' },
            complete,
            '确认已覆盖本次请求范围内所有授权日历的忙碌时间',
          ),
          button(
            '回传忙闲信息',
            async () => {
              if (!complete.checked) throw new Error('请先确认日历数据完整性');
              const now = new Date();
              const response = {
                status: 'available',
                complete: true,
                start: requestData.input.start,
                end: requestData.input.end,
                timeZone: requestData.input.timeZone,
                observedAt: now.toISOString(),
                expiresAt: new Date(now.getTime() + 240000).toISOString(),
                sourceVersion: 'user-reported-' + now.getTime(),
                evidence: 'pa_reported',
                calendars: ['user-reported-calendar'],
                windows: [{ start: requestData.input.start, end: requestData.input.end }],
                busy: busyRows.map((form) => form.read()),
              };
              await request('/tasks/' + task.id + '/pa-response', {
                requestId: requestData.requestId,
                response,
              });
              $('#editor').close();
              await renderProcesses();
            },
            'primary',
          ),
        );
      } else {
        const form = jsonSchemaForm(requestData.responseSchema);
        body.append(
          element('h3', {}, requestData.capability),
          form.node,
          button(
            '回传原任务',
            async () => {
              await request('/tasks/' + task.id + '/pa-response', {
                requestId: requestData.requestId,
                response: form.read(),
              });
              $('#editor').close();
              await renderProcesses();
            },
            'primary',
          ),
        );
      }
    }
    if (task.result?.execution?.steps)
      body.append(
        table(
          ['操作', '结果', '耗时'],
          task.result.execution.steps.map((step) => [step.tool, step.outcome, step.durationMs + ' ms']),
        ),
      );
    if (task.result && !locationRequest)
      body.append(
        element(
          'details',
          { class: 'section' },
          element('summary', {}, '任务结果'),
          element('pre', { class: 'code' }, JSON.stringify(task.result, null, 2)),
        ),
      );
    modal('任务 ' + task.id.slice(0, 8), body);
  };
  const machinery = element('div', { class: 'section' });
  const loadMachinery = async () => {
    const { renderMachinery } = await import('./machinery.js');
    await renderMachinery(machinery, { actions:state.model?.actionTypes ?? [], functions:state.model?.functionTypes ?? [],
      objectTypes:state.model?.objectTypes ?? [], scopes:state.identity?.scopes ?? [], evaluate:(name,input)=>request('/ontology/functions',{ontology:state.ontology,function:name,input}),
      element, button, field, select, table, modal, jsonInput, service, proposalDialog,
      openActions: (ref, actions, initial) => actionDialog({ ref }, { actions, initial, live: true }),
      openEvaluation: (id) => openScenarioEvaluation('trial', [], id),
      inspectTask: async (id) => {
        const task = await request('/tasks/' + encodeURIComponent(id));
        $('#editor').close();
        inspect(task);
      },
    });
  };
  $('#main').replaceChildren(
    heading('流程运行', '追踪原始任务、PA 信息回传及规则触发的执行步骤。', button('刷新', renderProcesses)),
    element('section', { class: 'section' },
      element('h2', {}, 'Machinery'), button('打开流程分析', loadMachinery), machinery),
    scenarioReviews(reviews, reviewPage, renderProcesses),
    surface(
      tasks.items.length
        ? table(
            ['任务', '状态', '创建时间'],
            tasks.items.map((task) => [
              task.id.slice(0, 12),
              task.state,
              new Date(task.createdAt).toLocaleString(),
            ]),
            (index) => inspect(tasks.items[index]),
          )
        : empty('当前身份没有任务。'),
    ),
    element(
      'div',
      { class: 'section' },
      element('h2', {}, '自动化执行'),
      surface(
        workflows.items.length
          ? table(
              ['流程', '状态', '进度', '反馈', ''],
              workflows.items.map((run) => [
                run.name,
                run.state,
                run.step + ' / ' + run.stepCount,
                run.error ?? '',
                element('div', {},
                  run.state === 'waiting-approval' && run.proposal && run.object &&
                    button('提交已批准方案', async () => {
                      const scenarioId = run.proposal.scenarioId;
                      const proposal = await request('/ontology/scenarios/' + encodeURIComponent(scenarioId) +
                        '?ontology=' + encodeURIComponent(state.ontology));
                      await applyAction(run.proposal.mergeAction, {
                        [run.proposal.mergeObjectParameter]: run.object, scenarioId, revision: proposal.revision,
                      }, null);
                      await renderProcesses(reviewPage);
                    }),
                  run.state === 'failed' && !run.proposal
                    ? button('重试剩余步骤', async () => {
                        await service('retry_workflow', { id: run.id });
                        await renderProcesses(reviewPage);
                      })
                    : ['pending', 'working', 'waiting-proposal', 'waiting-approval', 'failed'].includes(run.state)
                      && button('停止后续步骤', async () => {
                        await service('cancel_workflow', { id: run.id });
                        await renderProcesses(reviewPage);
                      }),
                ),
              ]),
            )
          : empty('没有流程执行记录。'),
      ),
    ),
  );
}
async function renderMap() {
  const types = state.model.objectTypes.filter((type) =>
    Object.values(type.properties).some((property) => property.schema?.type === 'object'),
  );
  const type = select(
      types.map((type) => [type.apiName, type.displayName]),
      types[0]?.apiName,
    ),
    property = element('input', { value: 'coordinates', placeholder: '坐标属性' }),
    canvas = element('canvas'),
    panel = element('div', { class: 'diagram' }, canvas),
    listing = element('div');
  const draw = async () => {
    const result = await service('map_objects', {
      query: { type: type.value, limit: 100 },
      property: property.value,
      ...(state.scenario ? { scenarioId: state.scenario } : {}),
    });
    const points = result.items;
    listing.replaceChildren(
      points.length
        ? table(
            ['地点', '纬度', '经度', '坐标系'],
            points.map((point) => [
              titleOf(point),
              point.latitude.toFixed(6),
              point.longitude.toFixed(6),
              point.coordinateSystem,
            ]),
          )
        : empty('当前页没有可读取的坐标。'),
    );
    const width = panel.clientWidth,
      height = 500,
      ratio = devicePixelRatio || 1;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const context = canvas.getContext('2d');
    context.scale(ratio, ratio);
    if (!points.length) return;
    const longitudes = points.map((point) => point.longitude),
      latitudes = points.map((point) => point.latitude);
    const minX = Math.min(...longitudes) - 0.005,
      maxX = Math.max(...longitudes) + 0.005,
      minY = Math.min(...latitudes) - 0.005,
      maxY = Math.max(...latitudes) + 0.005;
    context.fillStyle = '#f7faf8';
    context.fillRect(0, 0, width, height);
    context.strokeStyle = '#dbe7df';
    context.font = '11px Inter, sans-serif';
    for (let index = 0; index < 6; index++) {
      const x = 35 + (index / 5) * (width - 70),
        y = 35 + (index / 5) * (height - 70);
      context.beginPath();
      context.moveTo(x, 30);
      context.lineTo(x, height - 30);
      context.moveTo(30, y);
      context.lineTo(width - 30, y);
      context.stroke();
      context.fillStyle = '#779084';
      context.fillText((minX + (index / 5) * (maxX - minX)).toFixed(3) + '°', x - 20, height - 12);
      context.fillText((maxY - (index / 5) * (maxY - minY)).toFixed(3) + '°', 5, y - 5);
    }
    const positions = points.map((point) => ({
      point,
      x: 35 + ((point.longitude - minX) / (maxX - minX)) * (width - 70),
      y: 35 + ((maxY - point.latitude) / (maxY - minY)) * (height - 70),
    }));
    for (const point of positions) {
      context.beginPath();
      context.arc(point.x, point.y, 5, 0, Math.PI * 2);
      context.fillStyle = '#315f4f';
      context.fill();
      context.fillStyle = '#234337';
      context.fillText(titleOf(point.point), point.x + 8, point.y - 7);
    }
    canvas.onclick = (event) => {
      const rect = canvas.getBoundingClientRect(),
        x = event.clientX - rect.left,
        y = event.clientY - rect.top;
      const selected = positions.find((point) => Math.hypot(x - point.x, y - point.y) < 18);
      if (selected) {
        state.graphRoot = selected.point.ref;
        navigate('graph');
      }
    };
    if (result.cursor)
      listing.append(element('p', { class: 'subtle' }, '当前显示前 100 个对象，请在对象探索中进一步筛选。'));
  };
  $('#main').replaceChildren(
    heading('地图', '按来源坐标查看对象分布。坐标系保持原始声明，点击地点可查看关联。'),
    element('div', { class: 'toolbar' }, type, property, button('显示地点', draw, 'primary')),
    surface(panel),
    surface(listing),
  );
  if (types.length) await draw();
}
async function renderGeometry() {
  const models = await query({ type: 'GeometryAsset', limit: 100 });
  const picker = select(
    [['', '选择已保存的模型'], ...models.items.map((model) => [model.ref.id, titleOf(model)])],
    state.assetId ?? '',
  );
  const canvas = element('div', { class: 'geometry' }),
    information = element('div', { class: 'detail' }),
    files = element('input', { type: 'file', accept: '.glb,.gltf,.obj,.stl,.ply' });
  let modelUnits='file units';
  const units=element('input',{value:modelUnits,placeholder:'模型坐标单位'});units.oninput=()=>modelUnits=units.value;
  const viewer = await import('./model-viewer.js');
  const scene = viewer.createViewer(canvas, (points, distance) => {
    information.replaceChildren(
      element('h3', {}, points.length === 2 ? '测量' : '选中位置'),
      element(
        'p',
        { class: 'code' },
        points.map((point) => point.map((value) => value.toFixed(4)).join(', ')).join(' → '),
      ),
      ...(points.length === 2 ? [element('p', {}, '距离 ' + distance.toFixed(4)+' '+modelUnits)] : []),
      button('保存标注', () => {
        if (!state.assetId) throw new Error('请先保存模型，再保存关联标注');
        const name = element('input', { value: points.length === 2 ? '距离测量' : '模型标注' }),
          note = element('textarea');
        modal(
          '保存模型标注',
          element(
            'div',
            {},
            field('名称', name),
            field('备注', note),
            button(
              '保存',
              async () => {
                await applyAction(
                  'AnnotateGeometry',
                  {
                    id: crypto.randomUUID(),
                    asset: { type: 'GeometryAsset', id: state.assetId },
                    name: name.value,
                    note: note.value,
                    kind: points.length === 2 ? 'measurement' : 'note',
                    points,
                  },
                  null,
                );
                $('#editor').close();
                notice('标注已保存到本体');
              },
              'primary',
            ),
          ),
        );
      }),
    );
  });
  cleanup = () => scene.dispose();
  let loaded;
  const load = async (bytes, name) => {
    await scene.load(bytes, name);
    loaded = { bytes, name };
    information.replaceChildren(
      element('h3', {}, name),
      element('p', {}, '拖动旋转，滚轮缩放。开启测量后点击两个模型位置。'),
    );
  };
  files.onchange = () => {
    if (files.files[0]) {
      state.assetId = null;
      files.files[0]
        .arrayBuffer()
        .then((bytes) => load(bytes, files.files[0].name))
        .catch((error) => notice(error.message, true));
    }
  };
  picker.onchange = async () => {
    if (!picker.value) return;
    try {
      state.assetId = picker.value;
      const model = models.items.find((item) => item.ref.id === picker.value);
      modelUnits=model.properties.units;units.value=modelUnits;
      const response = await fetch('/ontology/media/' + state.assetId + '?ontology=' + state.ontology, {
        headers: { Authorization: 'Bearer ' + state.token },
      });
      if (!response.ok) throw new Error('模型文件不可读取');
      await load(await response.arrayBuffer(), model.properties.name + '.' + model.properties.format);
    } catch (error) {
      notice(error.message, true);
    }
  };
  $('#main').replaceChildren(
    heading('三维模型', '查看网格与点云，测量位置，并把标注保存为本体对象。'),
    element(
      'div',
      { class: 'toolbar' },
      picker,
      files,
      units,
      button(
        '保存模型',
        async () => {
          if (!loaded) throw new Error('请先选择模型文件');
          const format = loaded.name.split('.').at(-1).toLowerCase(),
            response = await fetch('/ontology/media?ontology=' + state.ontology, {
              method: 'POST',
              headers: {
                Authorization: 'Bearer ' + state.token,
                'Content-Type': 'application/octet-stream',
                'X-Asset-Name': encodeURIComponent(loaded.name),
                'X-Asset-Format': format,
                'X-Asset-Units':encodeURIComponent(modelUnits||'file units'),
              },
              body: loaded.bytes,
            });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error);
          state.assetId = result.id;
          notice('模型已保存');
        },
        'primary',
      ),
      button('测量两点', () => {
        scene.measure();
        notice('请依次点击模型上的两个位置');
      }),
      button('重置视角', () => scene.reset()),
    ),
    element(
      'div',
      { class: 'toolbar' },
      field(
        '剖切位置',
        element('input', {
          type: 'range',
          min: '-1',
          max: '1',
          step: '.01',
          value: '1',
          oninput: (event) => scene.section(Number(event.target.value)),
        }),
      ),
      button('保存剖切平面',async()=>{if(!state.assetId)throw new Error('先保存模型');await applyAction('AnnotateGeometry',{id:crypto.randomUUID(),asset:{type:'GeometryAsset',id:state.assetId},name:'剖切平面',note:'',kind:'section',points:scene.sectionState()},null);notice('剖切平面已保存');}),
      button('查看已保存标注', async () => {
        if (!state.assetId) throw new Error('请选择已保存的模型');
        const annotations = await relatedObjects({ type: 'GeometryAsset', id: state.assetId }, 'annotations',
          { scenarioId: null });
        modal(
          '模型标注',
          annotations.items.length
            ? element(
                'div',
                {},
                ...relatedNotice(annotations),
                table(
                  ['标题', '类型', '备注', '距离'],
                  annotations.items.map((item) => [
                    item.properties.name,
                    item.properties.kind,
                    item.properties.note,
                    item.properties.distance,
                  ]),
                ),
              )
            : empty('模型还没有标注。'),
        );
      }),
    ),
    element('div', { class: 'split' }, surface(canvas), surface(information)),
  );
}
const pages = {
  published: renderPublishedWorkflows,
  objects: renderObjects,
  model: renderModel,
  scenarios: renderScenarios,
  graph: renderGraph,
  schedule: renderSchedule,
  rules: renderRules,
  processes: renderProcesses,
  map: renderMap,
  geometry: renderGeometry,
};
async function render() {
  cleanup();
  cleanup = () => {};
  if (!state.token || (!state.model && state.page !== 'published')) return;
  $('#main').replaceChildren(element('div', { class: 'spinner' }, '正在读取…'));
  try {
    await pages[state.page]();
  } catch (error) {
    $('#main').replaceChildren(
      heading(document.querySelector(`[data-page="${state.page}"]`)?.textContent || '工作台'),
      element('div', { class: 'error' }, error.message),
      button('重试', render),
    );
  }
}
function navigate(page) {
  if (state.membership?.role==='member' && page!=='published') return;
  state.page = page;
  document
    .querySelectorAll('[data-page]')
    .forEach((button) => button.classList.toggle('active', button.dataset.page === page));
  render();
}
document
  .querySelectorAll('[data-page]')
  .forEach((button) => (button.onclick = () => navigate(button.dataset.page)));
$('#connect').onclick = () => login().catch((error) => notice(error.message, true));
$('#welcome-connect').onclick = $('#connect').onclick;
$('#account').onclick = () => {
  if (!state.identity) return;
  const owner = state.identity.owner;
  const identifier = element('input', { value: owner, readonly: true });
  modal('我的身份', element('div', {},
    element('p',{},({admin:'Admin',editor:'服务团队',member:'流程使用者'})[state.membership?.role] ?? ''),
    field('审阅身份', identifier, '把这个身份提供给方案发起人，即可接收审阅邀请。'),
    button('复制身份', async () => {
      await navigator.clipboard.writeText(owner);
      notice('已复制身份。');
    }),
  ));
};
$('#logout').onclick = async () => {
  if (state.session) await service('close_scenario_session', { sessionId: state.session }).catch(() => {});
  sessionStorage.removeItem('eigos_token');
  state.token = null;
  location.reload();
};
$('#reload').onclick = async () => {
  state.ontology = $('#ontology-name').value;
  try {
    await connected();
  } catch (error) {
    notice(error.message, true);
  }
};
window.addEventListener('pagehide', () => {
  if (state.session && state.token)
    fetch('/ontology/services/close_scenario_session', {
      method: 'POST',
      keepalive: true,
      headers: { Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.session }),
    }).catch(() => {});
});
if (state.token)
  connected().catch((error) => {
    notice(error.message, true);
    login();
  });
