import type { AgentDriver, AgentTool } from '../packages/runtime/agent.js';
import type { ObjectData, ObjectRef } from '../packages/ontology/schema.js';

/** Recorded tool decisions for deterministic regressions; production always uses the model driver. */
export class FixtureAgent implements AgentDriver {
  readonly model = 'fixture-tool-decisions';
  async run(prompt: string, tools: ReadonlyMap<string, AgentTool>, signal: AbortSignal) {
    const task = JSON.parse(prompt.split('\n').at(-1)!);
    const route = task.userRequest.route ?? { city: '上海市', origin: '中企云翠森林', destination: '前滩太古里' };
    const call = async (name: string, input: unknown): Promise<any> => { signal.throwIfAborted(); return tools.get(name)!.invoke(input); };
    await call('describe_ontology', { names: ['Location', 'RideEstimatable', 'PriceEstimate'] });
    const sources = await call('refresh_sources', { sources: ['origin', 'destination'].map(role => ({ source: 'DidiPlaces', input: { city: route.city, keywords: route[role] } })) });
    const sets = await call('query_ontology', { queries: sources.map((source: { receipt: ObjectRef }) => ({ type: 'Location', from: { object: source.receipt, link: 'places' }, where: { city: route.city } })) });
    const selected: ObjectData[] = [];
    for (const [i, role] of ['origin', 'destination'].entries()) {
      const places: ObjectData[] = sets[i].items;
      const choice = task.userRequest.places?.[role];
      if (places.length !== 1 && !choice) { await call('request_clarification', { message: '请确认完整地址。', choices: { role, places } }); return; }
      const place = places.find(item => !choice || item.ref.id === choice.id);
      if (!place) { await call('request_clarification', { message: '选择的地点不在来源结果中。' }); return; }
      selected.push(place);
    }
    const ref = await call('apply_action', { action: 'CreateRideRoute', input: { routeId: task.taskId, name: 'Selected route', origin: selected[0]!.ref, destination: selected[1]!.ref } });
    await call('follow_links', { links: [{ object: ref, link: 'origin', as: 'RideEstimatable' }, { object: ref, link: 'destination', as: 'RideEstimatable' }] });
    const request = await call('apply_action', { interface: { object: ref, type: 'RideEstimatable', action: 'requestEstimate' }, input: { requestId: task.taskId, route: ref, requestedAt: task.requestedAt } });
    await call('refresh_sources', { sources: [{ source: 'DidiEstimates', input: { request } }] });
    await call('complete_with_function', { function: 'readRideEstimates', input: { request, ...(route.serviceClass ? { serviceClass: route.serviceClass } : {}) } });
  }
}
