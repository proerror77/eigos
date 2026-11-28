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

function renderTaskForm(task, body) {
  const locationRequest = task.state === 'input-required' && task.result?.kind === 'pa-request' && task.result.capability === 'location.resolve';
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
    }
  }
  return {handledPA:locationRequest || task.result?.capability === 'calendar.freebusy', hideResult:locationRequest};
}

function runHotelWorkflow(workflow) {
  if (workflow.kind !== 'learned-hotel-itinerary') return false;
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
  return true;
}

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

function trialPreset(model, actions, functions) {
  const hasSchedule = actions.some(action => action.apiName === 'SaveScheduleActivity')
    && functions.some(fn => fn.apiName === 'validateSchedule')
    && ['SchedulePlan', 'CalendarAvailability'].every(name => model.objectTypes.some(type => type.apiName === name));
  if (hasSchedule) return {
    definition:schedulePreset(), description:'已填入排程示例。选择计划和日历证据，再填写两组时间。',
    caseInputs(parameter,target,evidence) {
      if (parameter !== 'plan' || target?.type !== 'SchedulePlan') return [];
      if (!evidence.some(entry => entry.type === 'CalendarAvailability')) evidence.push({type:'CalendarAvailability'});
      return schedulePreset().cases[0].inputs;
    },
  };
}

startWorkbench({
  trialPreset, preferredProcess:'EventTripStateLog', observationPreset:async () => (await import('./flight-watch.js')).flightWatch,
  tokenKey: 'eigos_token', actionKey: 'eigos_last_action',
  pages: { schedule: renderSchedule, map: renderMap, geometry: renderGeometry },
  renderTaskForm, decisionReview: transferDecisionReview, runWorkflow: runHotelWorkflow,
  workflowLabel: workflow => workflow.kind === 'learned-hotel-itinerary' ? '酒店行程 · 每次模拟前审批' : undefined,
  isMergeAction: action => action.apiName === 'CommitSchedulePlan',
});
