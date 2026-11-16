import { scenarioTrialForm } from './scenario-trial-form.js';

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

  async function trial(initialSet = '') {
    const options = await service('scenario_trial_options');
    const form = scenarioTrialForm(ui, options);
    const { select } = ui;
    const mode = select([['form', '表单'], ['json', '高级 JSON']], 'form');
    const editor = jsonInput({ cases: [], variants: [], metrics: [] });
    const raw = field('JSON 配置', editor);
    const candidate = element('input', { placeholder: '候选发布摘要（可选）' });
    const output = element('div', { 'aria-live': 'polite' });
    const promotion = element('div');
    const drawMode = () => {
      form.node.hidden = mode.value !== 'form';
      raw.hidden = mode.value !== 'json';
    };
    mode.onchange = drawMode;
    drawMode();
    const readTrial = () => mode.value === 'form' ? form.read() : JSON.parse(editor.value);

    const summary = (data) => {
      promotion.replaceChildren();
      const askForReview = (row, variant) => {
        const readers = element('textarea', { placeholder: '每行一个审阅身份' });
        promotion.replaceChildren(
          element('h3', {}, '送审 ' + variant.name),
          field('独立审阅者', readers, '审阅者可从顶栏「我的身份」复制身份。'),
          button('创建送审草稿', async () => {
            const reviewers = [...new Set(readers.value.split(/[\s,，]+/).filter(Boolean))];
            if (!reviewers.length) throw new Error('请输入审阅人的身份。');
            const result = await service('promote_evaluation_candidate', {
              run: data.run, case: row.name, variant: variant.name, requestId: crypto.randomUUID(), reviewers,
            });
            promotion.replaceChildren(element('p', { role: 'status' }, '已创建送审草稿 · 修订 ' + result.revision));
          }, 'primary'),
        );
      };
      output.replaceChildren(
        element('h3', {}, '试跑结果'),
        table(['流程', '完成', '未通过', '尝试步骤'], data.summary.map(row =>
          [row.name, row.completed, row.rejected, row.attemptedSteps])),
        ...data.cases.map(row => element('details', {},
          element('summary', {}, row.name + ' · ' + new Date(row.evaluatedAt).toLocaleString()),
          table(['流程', '结果', '指标', '原因', ''], row.variants.map(variant =>
            [variant.name, variant.status === 'completed' ? '完成' : '未通过', display(variant.metrics), variant.reason ?? '—',
              data.run && variant.status === 'completed' && button('送审', () => askForReview(row, variant)),
            ])),
          element('pre', { class: 'code' }, JSON.stringify(row, null, 2)),
        )),
        promotion,
      );
    };
    const run = async () => {
      output.replaceChildren(element('p', { role: 'status' }, '正在试跑…'));
      try {
        const trial = readTrial(), release = candidate.value.trim();
        summary(await (release
          ? service('trial_candidate_scenarios', { trial, release })
          : service('trial_scenarios', trial)));
      } catch (error) {
        output.replaceChildren(element('p', { class: 'error', role: 'alert' }, error.message));
      }
    };
    const showSuites = async () => {
      const { suites } = await service('evaluation_suites');
      output.replaceChildren(table(['评估集', '修订', ''], suites.map(suite =>
        [suite.name, suite.revision, button('重跑', async () => summary(await service('run_evaluation_suite', {
          id: suite.id, revision: suite.revision,
        })))])));
    };
    const suiteName = element('input', { placeholder: '评估集名称' });
    const machinerySet = element('input', { value: initialSet, placeholder: 'Machinery 对象集 ID' });
    const parameter = element('input', { value: initialSet ? 'target' : 'plan' });
    const caseLimit = element('input', { type: 'number', min: 1, max: 8, value: 4 });
    const loadCases = async () => {
      const input = parameter.value.trim();
      const { cases, total } = await service('evaluation_cases_from_set', {
        set: machinerySet.value.trim(), parameter: input, limit: Number(caseLimit.value),
      });
      if (!cases.length) throw new Error('对象集没有可读的实例。');
      if (mode.value === 'form') form.replaceCases(cases, input);
      else {
        const trial = readTrial(), template = trial.cases[0];
        trial.cases = cases.map(item => ({
          ...item, inputs: { ...template?.inputs, ...item.inputs },
          evidence: [...item.evidence, ...(template?.evidence ?? []).filter(entry => entry.object.id
            && !item.evidence.some(other => other.object.type === entry.object.type && other.object.id === entry.object.id))],
        }));
        editor.value = JSON.stringify(trial, null, 2);
      }
      output.replaceChildren(element('p', { role: 'status' }, '已载入 ' + cases.length + ' / ' + total + ' 个实例。'));
    };
    modal('离线试跑', element('div', {},
      element('p', {}, '用同一批证据试跑各候选流程。每个候选的编辑在试跑结束后自动回滚。'),
      field('配置方式', mode),
      form.node, raw,
      field('候选发布（可选）', candidate),
      button('运行试跑', run, 'primary'),
      element('details', { open: !!initialSet, class: 'section' },
        element('summary', {}, '对象集与已保存的评估集'),
        field('Machinery 对象集', machinerySet),
        field('实例输入参数', parameter), field('载入实例数', caseLimit), button('从对象集载入案例', loadCases),
        field('评估集名称', suiteName),
        button('保存评估集', async () => {
          const set = machinerySet.value.trim();
          await service('save_evaluation_suite', {
            name: suiteName.value.trim(), requestId: crypto.randomUUID(), trial: readTrial(),
            ...(set ? { machinerySet: set } : {}),
          });
          await showSuites();
        }),
        button('查看已保存评估集', showSuites),
      ),
      output,
    ));
  }
  return { compare, trial };
}
