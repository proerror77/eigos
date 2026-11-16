const namePattern = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const valueTypes = [
  ['string', '文本'], ['number', '数值'], ['boolean', '布尔值'],
  ['date-time', '日期时间'], ['null', '空值'], ['json', '结构化数据'],
];

const schedulePreset = () => {
  const validate = { function: 'validateSchedule', input: { plan: { input: 'plan' } }, path: ['valid'] };
  const variants = ['current', 'candidate'].map(name => ({
    name,
    steps: [
      { kind: 'action', name: 'allocate', action: 'SaveScheduleActivity', input: {
        plan: { input: 'plan' }, id: { value: 'trial-meeting' }, name: { value: '会议' },
        start: { input: name + 'Start' }, end: { input: name + 'End' },
      } },
      { ...validate, kind: 'check', name: 'validate', equals: true },
    ],
  }));
  return {
    cases: [{
      name: 'scheduleCase',
      evidence: [{ type: 'SchedulePlan', alias: 'plan' }, { type: 'CalendarAvailability' }],
      inputs: variants.flatMap(({ name }) => ['Start', 'End'].map(suffix => ({
        name: name + suffix, kind: 'date-time',
      }))),
    }],
    variants,
    metrics: [{ ...validate, name: 'feasible' }],
  };
};

export function scenarioTrialForm(ui, options) {
  const { element, button, field, select, jsonInput, jsonSchemaForm, service, model } = ui;
  const actions = model.actionTypes.filter(action => options.actions.includes(action.apiName));
  const functions = model.functionTypes.filter(fn => options.functions.includes(fn.apiName));
  const text = (value = '') => element('input', { value, autocomplete: 'off' });
  const key = (value) => {
    const name = value.trim();
    if (!namePattern.test(name)) throw new Error('名称须以英文字母开头，最多 80 个字母、数字或下划线。');
    return name;
  };

  function collection(title, initial, create, min, max, addLabel) {
    const body = element('div'), rows = [];
    const add = (value) => {
      if (rows.length >= max) throw new Error(title + '最多 ' + max + ' 项。');
      const row = create(value);
      const card = element('div', { class: 'trial-item' }, row.node, button('移除', () => {
        if (rows.length <= min) throw new Error(title + '至少 ' + min + ' 项。');
        rows.splice(rows.indexOf(row), 1);
        card.remove();
      }));
      rows.push(row);
      body.append(card);
    };
    initial.forEach(add);
    return {
      node: element('section', { class: 'section trial-section' },
        element('h3', {}, title), body, button(addLabel, () => add())),
      read: () => rows.map(row => row.read()),
    };
  }

  function valueEditor(kind = 'string', initial, scalarOnly = false) {
    const kindPicker = select(scalarOnly ? valueTypes.filter(([type]) => type !== 'json') : valueTypes, kind);
    const holder = element('div');
    let read;
    const draw = (value) => {
      const selected = kindPicker.value;
      if (selected === 'null') {
        holder.replaceChildren();
        read = () => null;
      } else if (selected === 'json') {
        const control = jsonInput(value ?? {});
        holder.replaceChildren(field('结构化值', control));
        read = () => JSON.parse(control.value);
      } else {
        const schema = selected === 'date-time' ? { type: 'string', format: 'date-time' } : { type: selected };
        const form = jsonSchemaForm({ properties: { value: { ...schema, title: '值' } } }, { value });
        holder.replaceChildren(form.node);
        read = () => {
          const result = form.read().value;
          if (result === undefined && selected !== 'string') throw new Error('请填写参数值。');
          return result ?? '';
        };
      }
    };
    kindPicker.onchange = () => draw();
    draw(initial);
    return { node: element('div', {}, field('值类型', kindPicker), holder), read: () => read() };
  }

  function evidence(entry = {}) {
    const types = model.objectTypes.map(type => [type.apiName, type.displayName ?? type.apiName]);
    const type = select(types, entry.type ?? types[0]?.[0]), id = text(entry.id), alias = text(entry.alias);
    const status = element('p', { class: 'subtle', role: 'status' }, '请读取并锁定对象修订。');
    let pinned;
    const invalidate = () => {
      pinned = undefined;
      status.textContent = '对象已修改，请重新读取修订。';
    };
    type.onchange = id.oninput = invalidate;
    const pin = async () => {
      const ref = { type: type.value, id: id.value.trim() };
      if (!ref.type || !ref.id) throw new Error('请选择对象类型并填写对象 ID。');
      const value = await service('read_object', { object: ref });
      if (ref.type !== type.value || ref.id !== id.value.trim()) return;
      pinned = { object: value.ref, revision: value.revision };
      status.textContent = '已锁定修订 ' + value.revision;
    };
    return {
      node: element('div', {},
        element('div', { class: 'form-grid' }, field('对象类型', type), field('对象 ID', id)),
        field('输入名称（可选）', alias, '填写后，候选流程可以按此名称引用这个对象。'),
        button('读取修订', pin), status),
      read: () => {
        if (!pinned) throw new Error('请先读取每个证据对象的修订。');
        return { pinned, alias: alias.value.trim() ? key(alias.value) : '' };
      },
    };
  }

  function caseInput(entry = {}) {
    const name = text(entry.name), value = valueEditor(entry.kind);
    return {
      node: element('div', {}, field('输入名称', name), value.node),
      read: () => [key(name.value), value.read()],
    };
  }

  function example(item = {}) {
    const name = text(item.name), clock = element('input', { type: 'datetime-local' });
    const proofs = collection('证据对象', item.evidence ?? [{}], evidence, 1, 20, '添加证据');
    const inputs = collection('案例输入', item.inputs ?? [], caseInput, 0, 20, '添加输入');
    return {
      node: element('div', {}, field('案例名称', name),
        field('评估时间（可选）', clock, '留空时使用本次试跑的时间。'), proofs.node, inputs.node),
      read: () => {
        const locks = proofs.read();
        const values = [...inputs.read(), ...locks.filter(item => item.alias).map(item => [item.alias, item.pinned.object])];
        if (new Set(values.map(([name]) => name)).size !== values.length) throw new Error('案例输入名称不能重复。');
        return {
          name: key(name.value), inputs: Object.fromEntries(values), evidence: locks.map(item => item.pinned),
          ...(clock.value ? { evaluatedAt: new Date(clock.value).toISOString() } : {}),
        };
      },
    };
  }

  function parameters(schema, initial = {}) {
    const rows = Object.entries(schema.properties ?? {}).map(([name, definition]) => {
      const required = schema.required?.includes(name);
      const source = initial[name];
      const mode = source ? Object.keys(source)[0] : required ? 'value' : 'omit';
      const option = select([
        ...(required ? [] : [['omit', '留空']]), ['value', '固定值'], ['input', '案例输入'], ['result', '前序步骤'],
      ], mode);
      const reference = text(source?.input ?? source?.result);
      const literal = jsonSchemaForm({ properties: { [name]: definition }, required: required ? [name] : [] },
        mode === 'value' && source ? { [name]: source.value } : {});
      const refField = field('引用名称', reference);
      const draw = () => {
        refField.hidden = option.value === 'omit' || option.value === 'value';
        literal.node.hidden = option.value !== 'value';
      };
      option.onchange = draw;
      draw();
      return {
        node: element('div', { class: 'trial-parameter' }, field(name + '的来源', option), refField, literal.node),
        read: () => {
          if (option.value === 'omit') return [];
          if (option.value !== 'value') return [[name, { [option.value]: key(reference.value) }]];
          const value = literal.read()[name];
          if (value === undefined) throw new Error('请填写参数 ' + name + '。');
          return [[name, { value }]];
        },
      };
    });
    return { node: element('div', {}, rows.map(row => row.node)), read: () => Object.fromEntries(rows.flatMap(row => row.read())) };
  }

  function operation(initial = {}, metric = false) {
    const name = text(initial.name);
    const kind = metric ? null : select([['action', '操作'], ['check', '检查']], initial.kind ?? 'action');
    const holder = element('div');
    let read;
    const draw = (draft = {}) => {
      const isAction = !metric && kind.value === 'action';
      const operationKey = isAction ? 'action' : 'function';
      const definitions = isAction ? actions : functions;
      const choices = definitions.map(entry => [entry.apiName, entry.apiName]);
      const picker = select(choices, draft[operationKey] ?? definitions[0]?.apiName);
      const fields = element('div');
      const drawParameters = (selected = {}) => {
        const definition = definitions.find(entry => entry.apiName === picker.value);
        const args = parameters(definition?.parameters ?? {}, selected.input);
        const path = text(selected.path?.join('.') ?? '');
        const compare = selected.equals;
        const equals = !isAction && !metric && valueEditor(
          compare === null ? 'null' : typeof (compare ?? true), compare === undefined ? true : compare, true,
        );
        fields.replaceChildren(args.node,
          !isAction && field('结果字段（可选）', path, '多层字段用点分隔。函数直接返回单个值时留空。'),
          !isAction && !metric && element('div', {}, element('h4', {}, '预期结果'), equals.node));
        read = () => {
          if (!definition) throw new Error('当前发布没有适用的' + (isAction ? '操作。' : '函数。'));
          const resultPath = path.value.trim();
          const parts = resultPath ? resultPath.split('.').map(part => /^\d+$/.test(part) ? Number(part) : key(part)) : [];
          return {
            name: key(name.value), [operationKey]: definition.apiName, input: args.read(),
            ...(metric ? { path: parts } : isAction ? { kind: 'action' } : { kind: 'check', path: parts, equals: equals.read() }),
          };
        };
      };
      picker.onchange = () => drawParameters();
      drawParameters(draft);
      holder.replaceChildren(field(isAction ? '已发布操作' : '只读函数', picker), fields);
    };
    if (kind) kind.onchange = () => draw();
    draw(initial);
    return { node: element('div', {}, field(metric ? '指标名称' : '步骤名称', name), kind && field('步骤类型', kind), holder), read: () => read() };
  }

  function variant(item = {}) {
    const name = text(item.name);
    const steps = collection('步骤', item.steps ?? [], operation, 0, 10, '添加步骤');
    return {
      node: element('div', {}, field('候选名称', name), steps.node),
      read: () => ({ name: key(name.value), steps: steps.read() }),
    };
  }

  const hasSchedule = actions.some(action => action.apiName === 'SaveScheduleActivity')
    && functions.some(fn => fn.apiName === 'validateSchedule')
    && ['SchedulePlan', 'CalendarAvailability'].every(name => model.objectTypes.some(type => type.apiName === name));
  const initial = hasSchedule ? schedulePreset() : {
    cases: [{ name: 'case1' }], variants: [{ name: 'current' }, { name: 'candidate' }], metrics: [{ name: 'result' }],
  };
  const cases = collection('案例', initial.cases, example, 1, 8, '添加案例');
  const variants = collection('候选流程', initial.variants, variant, 2, 4, '添加候选流程');
  const metrics = collection('共享指标', initial.metrics, item => operation(item, true), 1, 12, '添加指标');
  return {
    node: element('div', {},
      hasSchedule && element('p', { class: 'subtle' }, '已填入排程示例。选择计划和日历证据，再填写两组时间。'),
      cases.node,
      hasSchedule
        ? element('details', { class: 'section' }, element('summary', {}, '编辑候选流程和指标'), variants.node, metrics.node)
        : [variants.node, metrics.node]),
    read: () => ({ cases: cases.read(), variants: variants.read(), metrics: metrics.read() }),
  };
}
