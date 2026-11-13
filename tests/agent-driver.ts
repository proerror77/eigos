import type { AgentDriver, AgentTool } from '../packages/runtime/agent.js';

/** One recorded capability choice; production uses the real model driver. */
export class FixtureAgent implements AgentDriver {
  readonly model = 'fixture-tool-decisions';
  async run(prompt: string, tools: ReadonlyMap<string, AgentTool>, signal: AbortSignal) {
    const task = JSON.parse(prompt.split('\n').at(-1)!);
    const route = task.userRequest.route ?? { city: '上海市', origin: '中企云翠森林', destination: '前滩太古里' };
    signal.throwIfAborted();
    await tools.get('complete_with_action')!.invoke({
      action: { interface: { type: 'RideInquiry', implementation: 'RideRequest', action: 'estimate' }, input: route },
      read: { function: 'readRideEstimates', resultParameter: 'request' },
    });
  }
}
