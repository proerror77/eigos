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

  function trial(initialSet = '') {
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
    const summary = (data) => output.replaceChildren(
      table(['流程', '完成', '未通过', '尝试步骤'], data.summary.map(row =>
        [row.name, row.completed, row.rejected, row.attemptedSteps])),
      ...data.cases.map(row => element('details', {},
        element('summary', {}, row.name + ' · ' + new Date(row.evaluatedAt).toLocaleString()),
        table(['流程', '结果', '指标', '原因', ''], row.variants.map(variant=>
          [variant.name,variant.status==='completed'?'完成':'未通过',display(variant.metrics),variant.reason??'—',
            data.run&&variant.status==='completed'&&button('送审',async()=>{
              const reviewers=element('input',{placeholder:'用逗号分隔审阅者身份'});
              const panel=element('div');
              output.append(field('独立审阅者',reviewers),button('创建送审草稿',async()=>{
                const result=await service('promote_evaluation_candidate',{run:data.run,case:row.name,variant:variant.name,
                  requestId:crypto.randomUUID(),reviewers:reviewers.value.split(',').map(x=>x.trim()).filter(Boolean)});
                panel.textContent='送审草稿 '+result.id+' · 修订 '+result.revision;
              }),panel);
            })
          ])),
      )),
    );
    const showSuites=async()=>{
      const {suites}=await service('evaluation_suites');
      output.replaceChildren(table(['评估集','修订',''],suites.map(suite=>[
        suite.name,suite.revision,button('重跑',async()=>summary(await service('run_evaluation_suite',{id:suite.id,revision:suite.revision}))),
      ])));
    };
    const suiteName=element('input',{placeholder:'评估集名称'}),
      machinerySet=element('input',{placeholder:'Machinery 对象集 ID',value:initialSet}),
      parameter=element('input',{value:initialSet?'target':'plan'}),
      caseLimit=element('input',{type:'number',min:1,max:8,value:4}),
      candidateRelease=element('input',{placeholder:'可选：候选发布摘要'});
    const loadCases=async()=>{
      const data=await service('evaluation_cases_from_set',{set:machinerySet.value.trim(),
        parameter:parameter.value.trim(),limit:Number(caseLimit.value)});
      if(!data.cases.length)throw new Error('对象集没有可读的实例。');
      const trial=JSON.parse(editor.value), template=trial.cases[0];
      trial.cases=data.cases.map(item=>({...item,inputs:{...template?.inputs,...item.inputs},evidence:[
        ...item.evidence,...(template?.evidence??[]).filter(e=>e.object.id
          && !item.evidence.some(other=>other.object.type===e.object.type && other.object.id===e.object.id)),
      ]}));
      editor.value=JSON.stringify(trial,null,2);
      output.replaceChildren(element('p',{},'已载入 '+data.cases.length+' / '+data.total+' 个实例。请为这些实例设置试跑步骤、指标和其他必要证据。'));
    };
    modal('离线试跑', element('div', {},
      element('p', {}, '把同一组对象引用、修订和回执交给每个候选流程。试跑结束后自动回滚。'),
      field('试跑配置', editor),
      field('候选发布',candidateRelease),
      button('运行试跑', async () => {
        const trial=JSON.parse(editor.value);
        summary(candidateRelease.value
          ?await service('trial_candidate_scenarios',{trial,release:candidateRelease.value.trim()})
          :await service('trial_scenarios',trial));
      }, 'primary'),
      element('details',{open:!!initialSet},element('summary',{},'保存和重跑评估集'),
        field('名称',suiteName),field('Machinery 对象集',machinerySet),
        field('实例输入参数',parameter),field('载入实例数',caseLimit),button('从对象集载入案例',loadCases),
        button('保存评估集',async()=>{
          await service('save_evaluation_suite',{name:suiteName.value,requestId:crypto.randomUUID(),trial:JSON.parse(editor.value),
            ...(machinerySet.value?{machinerySet:machinerySet.value.trim()}:{})});
          await showSuites();
        }),button('查看已保存评估集',showSuites)),
      output,
    ));
  }
  return { compare, trial };
}
