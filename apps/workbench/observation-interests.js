const statuses = {
  watching: '跟进中',
  waiting: '等待来源事件',
  late: '检查逾期',
  stranded: '跟进中断',
  blocked: '跟进受阻',
  expired: '已到截止时间',
  canceled: '已停止',
  completed: '已完成',
};
const reasons = {
  horizon_reached: '已到授权截止时间',
  schedule_missing: '已登记的后台检查不存在',
  check_overdue: '已超过下次检查时间',
  reconciliation_overdue: '观察核对逾期',
  stop_state: '已到停止状态',
  terminal_state: '已到目标状态',
  owner_canceled: '用户已停止',
  watch_ended_before_target: '关联追踪在达到目标前结束',
  handoff_missing: '未找到已授权的关联追踪',
  no_check_before_deadline: '截止前没有下一次检查',
  scheduled_check_failed: '后台检查失败',
  scheduled_check_blocked: '后台检查受阻',
  awaiting_source_event: '等待来源产生新记录',
  no_source_evidence: '在允许的静默时间内未收到来源记录',
  source_silent: '来源已超过允许的静默时间',
  invalid_evidence_time: '来源时间无效',
  check_has_no_next_execution: '等待中的检查没有后续执行',
  check_lease_overdue: '运行中的检查已超过租约',
  permissions_or_contract_unavailable: '当前权限或已发布操作不可用',
  scheduled_check_expired: '后台检查已过期',
  scheduled_check_canceled: '后台检查已取消',
};
const time = (value) => (value ? new Date(value).toLocaleString('zh-CN') : '—');
const refText = (ref) => ref.type + ' · ' + ref.id;
const active = (item) => ['watching', 'waiting', 'late'].includes(item.status);
const hasScope = (ui, scope) => ui.scopes?.includes(scope);
const boundReadbacks = (ui, objectType) =>
  ui.actions.filter((action) => {
    const refs = Object.entries(action.objectParameters ?? {});
    return (
      refs.length === 1 &&
      refs[0][1] === objectType &&
      action.typeClasses?.some((tag) => tag.kind === 'observation' && tag.name === 'readback')
    );
  });
const simpleReadback = (action) => (action.parameters?.required ?? []).every((key) => key in action.objectParameters);
const flightProcess = 'FliggyFlightBookingIssuanceStateLog';

function scopeText(phase) {
  const goal = phase.attach ?? phase,
    limits = phase.limits ?? phase.parameters;
  const subject = phase.attach ? phase.attach.link + ' → ' + phase.attach.process : phase.process;
  return [
    subject,
    phase.action || '等待来源事件',
    goal.complete.length && '目标 ' + goal.complete.join(' / '),
    goal.stop?.length && '停止 ' + goal.stop.join(' / '),
    phase.intervalSeconds && phase.action && '检查间隔 ' + phase.intervalSeconds + ' 秒',
    phase.maxSilenceSeconds && '证据时限 ' + phase.maxSilenceSeconds + ' 秒',
    phase.wait && '最多等待 ' + phase.wait.maxSilenceSeconds + ' 秒',
    limits?.sources?.length && '来源 ' + limits.sources.join('、'),
    limits?.maxChecks && '最多 ' + limits.maxChecks + ' 次',
    limits?.monitorUntil && '航班跟进截止 ' + time(limits.monitorUntil),
  ]
    .filter(Boolean)
    .join(' · ');
}

function nextWake(item) {
  if (!active(item)) return '—';
  if (item.nextCheckAt) return '后台检查 ' + time(item.nextCheckAt);
  if (item.status === 'waiting' || item.phases[item.phaseIndex]?.wait)
    return '等待来源事件' + (item.nextReviewAt ? ' · 核对 ' + time(item.nextReviewAt) : '');
  return item.nextReviewAt ? '平台核对 ' + time(item.nextReviewAt) : '暂无已登记检查';
}

async function reviewPlan(ui, process, object, deadline, mode, settings) {
  const { element, button, field, modal, service } = ui;
  const phases = [];
  if (mode === 'booked-flight') {
    const { sources, maxChecks } = settings;
    const consent = await ui.evaluate('prepareBookedFlightWatch', {
      booking: object,
      monitorUntil: deadline,
      maxChecks,
      sources,
    });
    const { booking, ...parameters } = consent;
    if (booking.type !== object.type || booking.id !== object.id)
      throw new Error('航班核对返回了不同订单，请重新选择。');
    const evidence = (type) =>
      ui.objectTypes?.find((model) => model.apiName === type)?.properties.observedAt
        ? { evidenceProperty: 'observedAt' }
        : {};
    phases.push({
      name: '等候原单出票',
      ...evidence(object.type),
      process: process.type,
      action: 'RefreshFliggyFlightBooking',
      complete: ['issued'],
      stop: ['closed'],
      intervalSeconds: 300,
    });
    phases.push({
      name: '跟进已出票航段',
      process: process.type,
      action: 'StartBookedFlightWatch',
      parameters,
      complete: [],
      stop: ['closed'],
      attach: {
        link: 'itineraryWatches',
        process: 'FlightWatchStateLog',
        ...evidence('FlightWatch'),
        complete: ['completed'],
        stop: ['ended', 'cancelled'],
      },
    });
  } else {
    const { complete, stop, timing, evidenceProperty, maxSilenceSeconds } = settings;
    phases.push({
      name: '跟进' + process.name,
      process: process.type,
      complete,
      stop,
      ...(evidenceProperty ? { evidenceProperty } : {}),
      ...(maxSilenceSeconds ? { maxSilenceSeconds } : {}),
      ...(mode === 'event' ? { wait: { maxSilenceSeconds: timing } } : { action: mode, intervalSeconds: timing }),
    });
  }
  const requestId = crypto.randomUUID();
  const summary = phases.map((phase) => element('li', {}, phase.name + ' · ' + scopeText(phase)));
  modal(
    '授权后台跟进',
    element(
      'div',
      { class: 'section' },
      field('原对象', element('span', {}, refText(object))),
      field('授权截止', element('span', {}, time(deadline))),
      element('ol', {}, summary),
      mode === 'booked-flight' &&
        element(
          'p',
          {},
          '出票后授权查询 ' +
            settings.sources.join('、') +
            '，每个来源最多 ' +
            settings.maxChecks +
            ' 次，截止 ' +
            time(deadline) +
            '。查询可能消耗对应账户的额度。',
        ),
      button(
        '确认并开始跟进',
        async () => {
          await service('start_observation_interest', { requestId, object, deadline, phases });
          await settings.reload();
        },
        'primary',
      ),
    ),
  );
}

function startDialog(ui, process, object, reload) {
  const { element, button, field, select, modal } = ui;
  const deadline = element('input', { type: 'datetime-local', required: true });
  const readbacks = boundReadbacks(ui, object.type);
  const flight =
    process.type === flightProcess &&
    hasScope(ui, 'tasks:read') &&
    hasScope(ui, 'tasks:write') &&
    readbacks.some((a) => a.apiName === 'StartBookedFlightWatch') &&
    readbacks.some((a) => a.apiName === 'RefreshFliggyFlightBooking') &&
    ui.functions.some((f) => f.apiName === 'prepareBookedFlightWatch');
  const modes = [
    ...(flight ? [['booked-flight', '出票后持续跟进航班']] : []),
    ...readbacks.filter(simpleReadback).map((a) => [a.apiName, a.displayName ?? a.apiName]),
    ['event', '等待来源状态变化'],
  ];
  const mode = select(modes, modes[0][0]),
    form = element('div');
  function draw() {
    const isFlight = mode.value === 'booked-flight',
      isEvent = mode.value === 'event';
    const states = process.states;
    const complete = select([['', '选择目标状态'], ...states.map((s) => [s, s])], '');
    const stop = select([['', '无'], ...states.map((s) => [s, s])], '');
    const properties = ui.objectTypes?.find((type) => type.apiName === object.type)?.properties ?? {};
    const timestamps = Object.entries(properties).filter(
      ([, property]) =>
        !property.derived &&
        (property.schema?.anyOf ?? [property.schema]).some((schema) => schema?.format === 'date-time'),
    );
    const evidence = select([['', '已提交的状态变化时间'], ...timestamps.map(([key]) => [key, key])], '');
    const timing = element('input', {
      type: 'number',
      min: isEvent ? 1 : 30,
      max: isEvent ? 31 * 86400 : 86400,
      value: 300,
    });
    const maxChecks = element('input', { type: 'number', min: 2, max: 24, value: 8 });
    const positions = element('input', { type: 'checkbox' });
    const freshness = element('input', { type: 'number', min: 1, max: 31 * 86400, placeholder: '可选' });
    form.replaceChildren(
      ...(isFlight
        ? [
            field('状态来源', element('span', {}, '飞常准（VariFlight）')),
            field('同时查询 Flightradar24 位置', positions),
            field('每个所选来源最多检查次数', maxChecks),
          ]
        : [
            field('达到状态后完成', complete),
            field('遇到状态时停止', stop),
            field(isEvent ? '最长静默时间（秒）' : '检查间隔（秒）', timing),
            ...(!isEvent && timestamps.length
              ? [field('证据时限（秒）', freshness, '超过此时限仍无新回执时显示跟进缺口。')]
              : []),
            ...(timestamps.length
              ? [field('来源证据时间', evidence, '选择供应商观察时间可识别状态未变的新回执。')]
              : []),
          ]),
      button('核对跟进范围', async () => {
        const end = new Date(deadline.value).getTime();
        if (!Number.isFinite(end) || end < Date.now() + 1000) throw new Error('请选择明确的未来截止时间。');
        if (!isFlight && !complete.value) throw new Error('请选择跟进的目标状态。');
        if (!isFlight && complete.value === stop.value) throw new Error('目标状态与停止状态须不同。');
        const silence = !isFlight && !isEvent && freshness.value ? Number(freshness.value) : undefined;
        if (
          silence !== undefined &&
          (!evidence.value || !Number.isInteger(silence) || silence < 1 || silence > 31 * 86400)
        )
          throw new Error('请为证据时限选择来源时间，并填写 1 至 2678400 秒。');
        const number = Number(isFlight ? maxChecks.value : timing.value);
        if (
          !Number.isInteger(number) ||
          number < (isFlight ? 2 : isEvent ? 1 : 30) ||
          number > (isFlight ? 24 : isEvent ? 31 * 86400 : 86400)
        )
          throw new Error('请输入有效的次数或时间间隔。');
        await reviewPlan(
          ui,
          process,
          object,
          new Date(end).toISOString(),
          mode.value,
          isFlight
            ? {
                sources: positions.checked ? ['VariFlight', 'Flightradar24'] : ['VariFlight'],
                maxChecks: number,
                reload,
              }
            : {
                complete: [complete.value],
                stop: stop.value ? [stop.value] : [],
                timing: number,
                evidenceProperty: evidence.value,
                maxSilenceSeconds: silence,
                reload,
              },
        );
      }),
    );
  }
  mode.onchange = draw;
  draw();
  modal(
    '开始后台跟进',
    element(
      'div',
      { class: 'section' },
      field('原对象', element('span', {}, refText(object))),
      field('跟进方式', mode),
      field('授权截止', deadline),
      form,
    ),
  );
}

/** Reads the original object independently; a first state transition is not required. */
export async function showObjectInterests(ui, process, object) {
  const { element, button, modal, service } = ui;
  await service('read_object', { object });
  const refresh = async () => {
    const panel = element('section', { class: 'section' });
    await renderInterestList(ui, panel, object);
    modal(
      '对象跟进',
      element(
        'div',
        { class: 'section' },
        element('p', {}, refText(object)),
        panel,
        hasScope(ui, 'ontology:write') &&
          button('开始后台跟进', () => startDialog(ui, process, object, refresh), 'primary'),
      ),
    );
  };
  await refresh();
}

export async function renderInterestList(ui, panel, object, view = { cursor: null, previous: [], gapsOnly: false }) {
  const { element, button, table, service } = ui;
  const { cursor, previous, gapsOnly } = view;
  const show = (changes) => renderInterestList(ui, panel, object, { ...view, ...changes });
  const page = await service('observation_interests', { ...(object ? { object } : {}), ...(cursor ? { cursor } : {}) });
  const visible = gapsOnly
    ? page.items.filter((item) => ['stranded', 'blocked', 'late', 'expired'].includes(item.status))
    : page.items;
  const rows = visible.map((item) => {
    const phase = item.phases[item.phaseIndex],
      reason = reasons[item.reason] ?? item.reason;
    const canStop = hasScope(ui, 'ontology:write') && (item.canCancel ?? active(item));
    return [
      refText(item.object),
      phase?.name ?? '—',
      statuses[item.status] ?? item.status,
      item.lastObservedAt ? (item.lastState ?? '状态未知') + ' · ' + time(item.lastObservedAt) : '尚无可靠观察',
      nextWake(item),
      time(item.deadline),
      reason ?? '—',
      element(
        'details',
        {},
        element('summary', {}, '授权范围'),
        element(
          'ol',
          {},
          item.phases.map((p) => element('li', {}, p.name + ' · ' + scopeText(p))),
        ),
        item.attached && element('p', {}, '关联对象 ' + refText(item.attached)),
      ),
      canStop
        ? button('停止跟进', async () => {
            await service('cancel_observation_interest', { id: item.id });
            await show({});
          })
        : '—',
    ];
  });
  panel.replaceChildren(
    rows.length
      ? table(
          [
            '原对象',
            '当前阶段',
            '跟进状态',
            '最近可靠观察',
            '下次检查或事件',
            '截止时间',
            '结束或异常原因',
            '范围',
            '',
          ],
          rows,
        )
      : element(
          'p',
          {},
          gapsOnly
            ? '本页没有中断、受阻、逾期或到期的跟进。'
            : object
              ? '该对象没有可见的跟进记录。'
              : '当前页没有可见的跟进记录。',
        ),
    element(
      'div',
      { class: 'toolbar' },
      button('刷新跟进', () => show({})),
      button(gapsOnly ? '显示所有跟进' : '只看跟进缺口', () => show({ gapsOnly: !gapsOnly })),
      previous.length > 0 &&
        button('上一页跟进', () => show({ cursor: previous.at(-1), previous: previous.slice(0, -1) })),
      page.cursor && button('下一页跟进', () => show({ cursor: page.cursor, previous: [...previous, cursor] })),
    ),
  );
}
