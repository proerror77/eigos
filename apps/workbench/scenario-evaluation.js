export function scenarioEvaluation(ui, scenarios) {
  const { element, field, button, modal, table, jsonInput, stringify, service } = ui;
  const display = value => value === null || value === undefined ? '—' : stringify(value);
  const labels = {
    objectsCreated: '新增对象',
    objectsEdited: '编辑对象',
    objectsDeleted: '删除对象',
    linksAdded: '新增关系',
    linksRemoved: '删除关系',
    conflicts: '存在冲突',
  };
  function compare() {
    const choices = scenarios.map(row => ({
      row,
      box: element('input', { type: 'checkbox' }),
    }));
    const aggregates = jsonInput([]), metrics = jsonInput([]), output = element('div');
    modal('并排比较方案', element('div', {},
      choices.map(({ box, row }) => element('label', { class: 'toolbar' }, box, row.name + ' · 修订 ' + row.revision)),
      element('details', {},
        element('summary', {}, '配置共享指标'),
        field('Object Set 聚合', aggregates), field('Function 指标', metrics),
      ),
      button('比较', async () => {
        const picked = choices.filter(({ box }) => box.checked).map(({ row }) => ({ id: row.id, revision: Number(row.revision) }));
        if (picked.length < 2 || picked.length > 6) throw new Error('请选择 2 至 6 个方案');
        const data = await service('compare_scenarios', { scenarios: picked, aggregates: JSON.parse(aggregates.value), metrics: JSON.parse(metrics.value) });
        const labelsByScenario = data.scenarios.map(row => row.name + ' · 修订 ' + row.revision);
        const columns = [data.baseline, ...data.scenarios];
        const rows = [
          ...Object.entries(labels).map(([key, label]) => [label, '—', ...data.scenarios.map(row => display(row.changes[key]))]),
          ...Object.keys(data.baseline.metrics).map(name => [name, ...columns.map(row => display(row.metrics[name]))]),
          ...data.baseline.aggregates.map((_, index) => [
            '聚合 ' + (index + 1), ...columns.map(row => display(row.aggregates[index].items)),
          ]),
        ];
        output.replaceChildren(
          element('p', {}, '比较时间 ' + new Date(data.evaluatedAt).toLocaleString()),
          table(['指标', '正式数据', ...labelsByScenario], rows),
          data.scenarios.map((row, index) => element('details', {},
            element('summary', {}, labelsByScenario[index] + ' · 变更预览（每类最多 50 条）'),
            element('pre', { class: 'code' }, JSON.stringify(row.preview, null, 2)),
          )),
        );
      }, 'primary'),
      output,
    ));
  }

  function trial() {
    const plan = { type: 'SchedulePlan', id: '' };
    const calendar = { type: 'CalendarAvailability', id: '' };
    const check = { function: 'validateSchedule', input: { plan: { input: 'plan' } }, path: ['valid'] };
    const allocate = (start, end) => ({
      kind: 'action', name: 'allocate', action: 'SaveScheduleActivity',
      input: { plan: { input: 'plan' }, id: { value: 'meeting' }, name: { value: 'Meeting' },
        start: { input: start }, end: { input: end } },
    });
    const editor = jsonInput({
      cases: [{ name: 'sameCalendar',
        inputs: { plan, currentStart: '', currentEnd: '', candidateStart: '', candidateEnd: '' },
        evidence: [{ object: plan, revision: 1 }, { object: calendar, revision: 1 }] }],
      variants: [
        { name: 'current', steps: [allocate('currentStart', 'currentEnd'), { ...check, kind: 'check', name: 'validate', equals: true }] },
        { name: 'candidate', steps: [allocate('candidateStart', 'candidateEnd'), { ...check, kind: 'check', name: 'validate', equals: true }] },
      ],
      metrics: [{ ...check, name: 'valid' }],
    });
    const output = element('div');
    modal('离线试跑', element('div', {},
      element('p', {}, '把同一组对象引用、修订和回执交给每个候选流程。试跑结束后自动回滚。'),
      field('试跑配置', editor),
      button('运行试跑', async () => {
        const data = await service('trial_scenarios', JSON.parse(editor.value));
        output.replaceChildren(
          table(['流程', '完成', '未通过', '尝试步骤'], data.summary.map(row =>
            [row.name, row.completed, row.rejected, row.attemptedSteps])),
          ...data.cases.map(row => element('details', {},
            element('summary', {}, row.name + ' · ' + new Date(row.evaluatedAt).toLocaleString()),
            table(['流程', '结果', '指标', '原因'], row.variants.map(variant =>
              [variant.name, variant.status === 'completed' ? '完成' : '未通过', display(variant.metrics), variant.reason ?? '—'])),
            element('pre', { class: 'code' }, JSON.stringify(row, null, 2)),
          )),
        );
      }, 'primary'),
      output,
    ));
  }
  return { compare, trial };
}
