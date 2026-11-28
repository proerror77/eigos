export const flightWatch = {
  mode: 'booked-flight', label: '出票后持续跟进航班',
  available(ui, process, readbacks) {
    return process.type === 'FliggyFlightBookingIssuanceStateLog' &&
      ui.scopes?.includes('tasks:read') &&
      ui.scopes?.includes('tasks:write') &&
      readbacks.some((a) => a.apiName === 'StartBookedFlightWatch') &&
      readbacks.some((a) => a.apiName === 'RefreshFliggyFlightBooking') &&
      ui.functions.some((f) => f.apiName === 'prepareBookedFlightWatch');
  },
  controls({element,field}) {
    const checks = element('input',{type:'number',min:2,max:24,value:8});
    const positions = element('input',{type:'checkbox'});
    return {
      fields: [field('状态来源',element('span',{},'飞常准（VariFlight）')),field('同时查询 Flightradar24 位置',positions),field('每个所选来源最多检查次数',checks)],
      read() {
        const maxChecks = Number(checks.value);
        if (!Number.isInteger(maxChecks) || maxChecks < 2 || maxChecks > 24) throw new Error('请输入有效的次数或时间间隔。');
        return {sources:positions.checked ? ['VariFlight','Flightradar24'] : ['VariFlight'],maxChecks};
      },
    };
  },
  async phases(ui, process, object, deadline, settings) {
    const phases = [];
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
    return phases;
  },
  summary(settings, deadline) {
    return '出票后授权查询 '+settings.sources.join('、')+'，每个来源最多 '+settings.maxChecks+' 次，截止 '+new Date(deadline).toLocaleString()+'。查询可能消耗对应账户的额度。';
  },
};
