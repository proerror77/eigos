const duration = value => value == null ? '—' : new Intl.NumberFormat('zh-CN', {
  maximumFractionDigits: 1, style: 'unit', unit: value < 60000 ? 'second' : value < 3600000 ? 'minute' : 'hour',
}).format(value / (value < 60000 ? 1000 : value < 3600000 ? 60000 : 3600000));

const status = { conforming: '符合', deviation: '偏离', unknown: '证据不足' };
const localTime = iso => new Date(iso).toLocaleString('zh-CN');
const edgeText = edge => (edge.from ?? '开始') + ' → ' + (edge.to ?? '结束');

function processGraph(result, element, button, selectState) {
  const states = result.states;
  if (!states.length) return null;
  const width = 720, step = 36;
  const height = Math.max(90, states.length * step + 28);
  const svg = (type, attributes, text) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', type);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    if (text) node.textContent = text;
    return node;
  };
  const graph = svg('svg', { viewBox: '0 0 ' + width + ' ' + height,
    class: 'machinery-graph', role: 'img', 'aria-label': '实际与预期流程图' });
  const y = index => 28 + index * step;
  const positions = new Map(states.map((row, index) => [row.name, y(index)]));
  result.transitions.forEach((edge, i) => {
    const start = edge.from === null ? 10 : positions.get(edge.from);
    const end = edge.to === null ? height - 5 : positions.get(edge.to);
    if (start === undefined || end === undefined) return;
    const x = 224 + (i % 12) * 34;
    const curve = svg('path', {
      d: 'M 199 ' + start + ' C ' + x + ' ' + start + ', ' + x + ' ' + end + ', 205 ' + end,
      class: edge.expected === false ? 'unexpected' : edge.count ? 'observed' : 'expected',
      'stroke-width': 1 + Math.min(6, Math.log2(1 + edge.count)),
    });
    curve.append(svg('title', {}, edgeText(edge) + ' · ' + edge.count + ' 次'));
    graph.append(curve, svg('path', {
      d: 'M 205 ' + (end - 3) + ' L 199 ' + end + ' L 205 ' + (end + 3),
      class: edge.expected === false ? 'unexpected' : edge.count ? 'observed' : 'expected',
    }));
  });
  states.forEach((row, index) => {
    graph.append(svg('rect', { x: 0, y: y(index) - 13, width: 192, height: 26, rx: 4 }));
    const label = row.name.length > 24 ? row.name.slice(0, 24) + '…' : row.name;
    graph.append(svg('text', { x: 9, y: y(index) + 4 }, label));
  });
  return element('div', { class: 'section' }, graph,
    element('div', { class: 'toolbar' }, states.map(row =>
      button(row.name + ' · ' + row.current, () => selectState(row.name)))));
}

export async function renderMachinery(body, ui) {
  const { element, button, field, select, table, modal, jsonInput, service, proposalDialog, inspectTask, openActions, openEvaluation } = ui;

  async function open() {
    const [processes, reviews, sets] = await Promise.all([
      service('machinery_processes'), service('machinery_reviews'), service('list_sets'),
    ]);
    if (!processes.items.length) {
      body.replaceChildren(element('p', {}, '当前身份没有可读的过程日志。'));
      return;
    }
    const type = select(processes.items.map(item => [item.type, item.name]),
      processes.items.find(item => item.type === 'EventTripStateLog')?.type ?? processes.items[0].type);
    const set = select([['', '所有可读实例'], ...sets.items.map(item => [item.id, item.name])], '');
    const today = new Date();
    const day = date => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const from = element('input', { type: 'date', value: day(new Date(today.getTime() - 7 * 86400000)) });
    const to = element('input', { type: 'date', value: day(today) });
    const externalSource = element('input',{placeholder:'留空使用 EIGOS 提交历史'});
    const minCases = element('input', { type: 'number', min: 1, value: 1 });
    const coverage = element('input', { type: 'number', min: 1, max: 100, value: 100 });
    const clocks = [['recordedAt', '记录时间'], ['observedAt', '来源观察时间']];
    const durationClock = select(clocks, 'recordedAt');
    const includeIdle = element('input', { type: 'checkbox', checked: true });
    const progress = element('div', { 'aria-live': 'polite' });
    const output = element('div', { class: 'section' });
    let generation = 0;
    const dayStart = date => new Date(date.replaceAll('-', '/') + ' 00:00:00');
    const dateRange = () => {
      const start = dayStart(from.value), end = dayStart(to.value);
      end.setDate(end.getDate() + 1);
      return { from: start.toISOString(), to: end.toISOString() };
    };

    async function render(input = { type: type.value, ...dateRange(),
      ...(set.value ? { setId: set.value } : {}), ...(externalSource.value ? {externalSource:externalSource.value} : {}), includeIdle: includeIdle.checked, durationClock: durationClock.value,
      mining: { minCases: Number(minCases.value), coveragePercent: Number(coverage.value) } }, loaded) {
      const id = ++generation;
      progress.textContent = '正在读取过程日志…';
      try {
        const result = loaded ?? await service('machinery_analysis', input);
        const fixed = { ...input, to: result.to };
        if (id !== generation) return;
        function detail(item) {
          return (async () => {
            const data = await service('machinery_analysis', {
              type: input.type, from: input.from, to: result.to, object: item.object, durationClock: result.durationClock,
              ...(input.externalSource ? {externalSource:input.externalSource} : {}),
            });
            const entry = data.cases[0];
            if (!entry) throw new Error('当前查询范围内没有可读的完整记录。');
            const timeline = entry.timeline;
            const rows = timeline.map(event => [
              localTime(event.recordedAt), edgeText(event), event.action ?? '—', event.source ?? '—',
              event.taskId ? button('原任务', async () => inspectTask(event.taskId)) : '—',
            ]);
            const childButtons = (data.reference?.subprocesses ?? []).map(child => button(
              processes.items.find(process => process.type === child.process)?.name ?? child.process,
              async () => {
                document.querySelector('#editor').close();
                await render({ type: child.process, from: fixed.from, to: fixed.to, durationClock: result.durationClock,
                  focus: { parent: item.object, type: input.type, link: child.link } });
              },
            ));
            const actions = (data.reference?.transitions ?? [])
              .filter(edge => edge.from === entry.current && edge.action)
              .map(edge => edge.action);
            modal('流程记录', element('div', { class: 'section' },
              element('p', {}, entry.states.join(' → ')),
              element('div', { class: 'toolbar' }, childButtons,
                actions.length && button('业务操作', async () => {
                  document.querySelector('#editor').close();
                  openActions(item.object, actions);
                })),

              table(['记录时间', '状态变化', 'Action', '来源', '证据'], rows),
            ));
          })();
        }

        const pathTable = table(['实际路径', '流程实例', '样本覆盖'],
          result.paths.map(path => [path.states.join(' → ') || '无状态', path.count, path.partial ? '窗口内片段' : '自首次记录起']),
          index => render({ ...fixed, offset: 0, filter: { path: result.paths[index].id } }));
        const transitions = table(['状态转换', '次数', '流程实例', '预期流程', '关联 Action'],
          result.transitions.map(edge => [edgeText(edge), edge.count, edge.cases,
            edge.expected === true ? '已定义' : edge.expected === false ? '新发现' : '未配置参考模型',
            edge.action ?? Object.keys(edge.observedActions).join('、')]),
          index => {
            const { from, to } = result.transitions[index];
            return render({ ...fixed, offset: 0, filter: { edge: { from, to } } });
          });
        const dwell = table(['状态', '曾到达', '当前', '历史 P50', '历史 P95', '当前最长', '超过目标'],
          result.states.map(row => [row.name, row.ever, row.current, duration(row.historical.p50Ms),
            duration(row.historical.p95Ms), duration(row.currentDuration.maxMs), row.dwellSeconds ? row.breaches : '—']),
          index => render({ ...fixed, offset: 0, filter: { state: result.states[index].name } }));
        const distribution = element('details', { class: 'section' }, element('summary', {}, '停留时长分布'),
          result.states.map(row => element('section', {},
            element('h4', {}, row.name),
            table(['时间区间', '已结束', '仍停留'], row.historical.distribution.map((bucket, index) => [
              duration(bucket.fromMs) + ' – ' + (bucket.toMs == null ? '以上' : duration(bucket.toMs)),
              bucket.count, row.currentDuration.distribution[index].count,
            ]), index => {
              const bucket = row.historical.distribution[index];
              return render({ ...fixed, offset: 0, filter: { duration: {
                state: row.name, minMs: bucket.fromMs,
                ...(bucket.toMs == null ? {} : { maxExclusiveMs: bucket.toMs }),
              } } });
            }),
          )));
        const bottlenecks = table(['瓶颈状态', '累计停留', '历史 P95', '当前最长', '超过目标'],
          result.findings.bottlenecks.map(row => [row.state, duration(row.totalMs),
            duration(row.completedP95Ms), duration(row.currentMaxMs), row.breaches]),
          index => render({ ...fixed, offset: 0, filter: { state: result.findings.bottlenecks[index].state } }));
        const cases = table(['流程实例', '窗口末状态', '一致性', '状态转换'],
          result.cases.map(item => [item.object.id, item.current, status[item.conformance], item.transitions]),
          index => detail(result.cases[index]));
        const author = button('编辑流程模型', async () => {
          const prior = result.reference ?? { states: [], transitions: [] };
          const editor = jsonInput({
            ...prior,
            states: [...prior.states, ...result.mined.states.map(({ name }) => ({ name }))],
            transitions: [...prior.transitions, ...result.mined.transitions.map(({ from, to }) => ({ from, to }))],
          });
          const comparison = element('p', { 'aria-live': 'polite' });
          modal('流程模型', element('div', { class: 'section' },
            field('预期状态、转换与子流程', editor),
            comparison,
            element('div', { class: 'toolbar' },
              button('对比已发生的路径', async () => {
                const projected = await service('machinery_analysis', { ...fixed, candidate: JSON.parse(editor.value) });
                const { baseline, candidate } = projected.comparison;
                comparison.textContent = '符合参考模型的实例数 ' + baseline.conforming + ' → ' + candidate.conforming
                  + '，偏离实例数 ' + baseline.deviation + ' → ' + candidate.deviation;
              }),
              button('保存到定义分支', async () => {
                const draft = await service('machinery_propose_model', { type: input.type, release: result.release,
                  name: '流程模型 ' + input.type, model: JSON.parse(editor.value) });
                document.querySelector('#editor').close();
                await proposalDialog(draft);
              }, 'primary'),
            ),
          ));
        });
        const configureRule = button('配置状态规则', async () => {
          const { items } = await service('workflows');
          const workflows = items.filter(item => !item.kind);
          if (!workflows.length) throw new Error('请先在规则页面保存一个 Workflow。');
          const name = element('input', { value: '状态规则 ' + input.type });
          const trigger = select(result.states.map(row => row.name), result.findings.bottlenecks[0]?.state ?? result.states[0].name);
          const dwellSeconds = element('input', { type: 'number', min: 1, placeholder: '进入状态后立即触发' });
          const workflow = select(workflows.map(item => [item.id, item.name]), workflows[0].id);
          const enabled = element('input', { type: 'checkbox' });
          modal('状态触发规则', element('div', { class: 'section' },
            field('名称', name), field('进入状态', trigger), field('停留秒数', dwellSeconds),
            field('Workflow', workflow), field('启用规则', enabled),
            button('保存规则', async () => {
              await service('save_rule', { name: name.value, workflow: workflow.value, enabled: enabled.checked,
                process: { type: input.type, to: trigger.value,
                  ...(dwellSeconds.value ? { dwellSeconds: Number(dwellSeconds.value) } : {}) } });
              document.querySelector('#editor').close();
            }, 'primary'),
          ));
        });
        progress.textContent = result.casesTotal + ' 个流程实例 · 耗时按'
          + (result.durationClock === 'observedAt' ? '来源观察时间' : '记录时间');
        const setName=element('input',{placeholder:'待复用实例名称'});
        const saved=element('div',{role:'status'});
        output.replaceChildren(
          result.casesTotal>0&&element('div',{class:'toolbar'},setName,button('保存匹配实例为对象集',async()=>{
            const result=await service('save_machinery_cases',{analysis:fixed,name:setName.value,requestId:crypto.randomUUID()});
            saved.replaceChildren(element('span',{},'对象集 '+result.id+' 已保存。'),
              button('用对象集试跑',()=>openEvaluation(result.id)));
          }),saved),
          element('div', { class: 'toolbar' },
            (input.filter || input.focus) && button('清除筛选', () => render()),
            ...Object.entries(result.conformance).map(([key, count]) =>
              button(status[key] + ' ' + count, () => render({ ...fixed, offset: 0, filter: { conformance: key } }))),
            author, result.states.length > 0 && configureRule,
          ),
          element('h3', {}, '流程图'),
          processGraph(result, element, button, name => render({ ...fixed, offset: 0, filter: { state: name, current: true } })),
          element('h3', {}, '实际路径'), pathTable,
          element('h3', {}, '瓶颈排名'), bottlenecks,
          element('h3', {}, '状态停留'), dwell, distribution,
          element('h3', {}, '转换与预期流程'), transitions,
          element('h3', {}, '流程实例'), cases,
          element('div', { class: 'toolbar' },
            !!input.offset && button('上一页', () => render({ ...fixed, offset: Math.max(input.offset - 25, 0) })),
            result.nextOffset !== null && button('下一页', () => render({ ...fixed, offset: result.nextOffset })),
          ),
        );
      } catch (error) {
        if (id === generation) { progress.textContent = ''; output.replaceChildren(); }
        throw error;
      }
    }
    const reviewPanel = element('div', { class: 'section' });
    function showReviews() {
      reviewPanel.replaceChildren(element('h3', {}, '定期复盘'),
        element('div', { class: 'toolbar' }, button('配置复盘', () => editReview())),
        ...reviews.items.map(review => element('div', { class: 'toolbar' },
          element('span', {}, review.name + ' · 每 ' + review.periodDays + ' 天'),
          element('span', {}, review.enabled ? '已启用' : '已暂停'),
          review.checkpoint && button('查看上次复盘', async () => {
            const report = await service('machinery_review', { id: review.id });
            await render({ type: review.type, from: report.from, to: report.to, includeIdle: false,
              mining: { minCases: review.minCases }, durationClock: review.durationClock }, report);
          }),
          button('立即复盘', async () => {
            const report = await service('run_machinery_review', { id: review.id });
            review.checkpoint = { from: report.from, to: report.to };
            review.error = null;
            showReviews();
            await render({ type: review.type, from: report.from, to: report.to, includeIdle: false,
              mining: { minCases: review.minCases }, durationClock: review.durationClock }, report);
          }),
          button('编辑', () => editReview(review)),
          review.error && element('span', {}, '上次复盘失败'),
        )));
    }

    function editReview(prior) {
      const name = element('input', { value: prior?.name ?? '每周流程复盘', maxlength: 200 });
      const process = select(processes.items.map(item => [item.type, item.name]), prior?.type ?? type.value);
      const days = element('input', { type: 'number', min: 1, max: 90, value: prior?.periodDays ?? 7 });
      const minimum = element('input', { type: 'number', min: 1, value: prior?.minCases ?? 2 });
      const clock = select(clocks, prior?.durationClock ?? 'recordedAt');
      const enabled = element('input', { type: 'checkbox', checked: prior?.enabled ?? false });
      modal('定期复盘', element('div', { class: 'section' }, field('名称', name), field('流程', process),
        field('间隔天数', days), field('耗时依据', clock), field('挖掘所需最少实例', minimum), field('启用定期复盘', enabled),
        button('保存', async () => {
          const result = await service('save_machinery_review', {
            ...(prior ? { id: prior.id, revision: prior.revision } : {}), name: name.value,
            type: process.value, periodDays: Number(days.value), minCases: Number(minimum.value),
            durationClock: clock.value, enabled: enabled.checked,
          });
          if (prior) reviews.items.splice(reviews.items.indexOf(prior), 1, result);
          else reviews.items.push(result);
          document.querySelector('#editor').close();
          showReviews();
        }, 'primary')));
    }
    showReviews();
    body.replaceChildren(element('div', { class: 'toolbar' },
      field('流程', type), field('对象集', set), field('外部历史来源',externalSource), field('起始日期', from), field('结束日期', to),
      field('挖掘所需最少实例', minCases), field('挖掘覆盖率（%）', coverage),
      field('耗时依据', durationClock), field('包含窗口内无转换的实例', includeIdle), button('分析流程', () => render(), 'primary')),
      reviewPanel, progress, output);
    await render();
  }
  await open();
}
