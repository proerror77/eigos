import assert from 'node:assert/strict';
import { test } from 'node:test';

type Node = {
  text?: string;
  label?: string;
  value?: string;
  checked?: boolean;
  children: unknown[];
  onchange?: () => void;
  click?: () => Promise<void>;
  replaceChildren(...children: unknown[]): void;
};
const object = { type: 'FliggyFlightBooking', id: 'original-booking' };
const processModel = {
  type: 'FliggyFlightBookingIssuanceStateLog',
  name: '机票订单',
  objectType: object.type,
  states: ['unpaid', 'issued', 'closed'],
};
const phase = {
  name: '等候出票',
  process: processModel.type,
  action: 'RefreshFliggyFlightBooking',
  complete: ['issued'],
  stop: ['closed'],
};
const soon = new Date(Date.now() + 3600_000).toISOString();
function node(children: unknown[] = [], attributes: Partial<Node> = {}): Node {
  return {
    ...attributes,
    children,
    replaceChildren(...items: unknown[]) {
      this.children = items;
    },
  };
}
function contents(value: unknown): string[] {
  if (value == null || typeof value === 'boolean') return [];
  if (typeof value !== 'object') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(contents);
  return contents([(value as Node).label, (value as Node).children]);
}
function setup(scopes = ['ontology:read', 'ontology:write', 'tasks:read', 'tasks:write']) {
  let dialog = node();
  const events: { name: string; input: any }[] = [];
  const buttons = new Map<string, Node>(),
    fields = new Map<string, Node>();
  const ui = {
    scopes,
    actions: ['RefreshFliggyFlightBooking', 'StartBookedFlightWatch', 'PayFliggyFlightBooking'].map((apiName) => ({
      apiName,
      typeClasses: apiName === 'PayFliggyFlightBooking' ? [] : [{ kind: 'observation', name: 'readback' }],
      objectParameters: { booking: object.type },
      parameters: { required: apiName === 'StartBookedFlightWatch' ? ['booking', 'bookingDigest'] : ['booking'] },
    })),
    functions: [{ apiName: 'prepareBookedFlightWatch' }],
    element: (_tag: string, attrs: Partial<Node>, ...children: unknown[]) => node(children, attrs),
    field: (label: string, input: Node) => {
      fields.set(label, input);
      return node([label, input]);
    },
    select: (_options: unknown, value: string) => node([], { value }),
    table: (headers: unknown[], rows: unknown[][]) => node([headers, rows]),
    modal: (label: string, content: Node) => {
      dialog = node([label, content]);
    },
    button: (label: string, click: () => Promise<void>) => {
      const b = node([], { label, click });
      buttons.set(label, b);
      return b;
    },
    evaluate: async (name: string, input: Record<string, unknown>) => {
      events.push({ name, input });
      return { ...input, bookingDigest: 'a'.repeat(64), sourceAuthorities: { VariFlight: 'b'.repeat(64) } };
    },
    service: async (name: string, input: any = {}) => {
      events.push({ name, input: structuredClone(input) });
      if (name === 'observation_interests' && input.object) return { items: [] };
      if (name === 'observation_interests')
        return {
          items: [
            {
              id: 'interest-id',
              object,
              phaseIndex: 0,
              phases: [phase],
              status: input.cursor ? 'stranded' : 'waiting',
              lastState: 'unpaid',
              lastObservedAt: soon,
              nextCheckAt: null,
              nextReviewAt: soon,
              deadline: soon,
              reason: input.cursor ? 'schedule_missing' : null,
            },
          ],
          cursor: input.cursor ? null : 'page2',
        };
      return {};
    },
  };
  return { ui, buttons, fields, events, dialog: () => dialog };
}
const moduleUrl = new URL('../apps/workbench/observation-interests.js', import.meta.url).href;
test('the Machinery interests dashboard shows absent wakeups, time bounds and persisted reasons on later pages', async () => {
  const { renderInterestList } = await import(moduleUrl),
    f = setup(),
    panel = node();
  await renderInterestList(f.ui, panel);
  assert.deepEqual(f.events[0], { name: 'observation_interests', input: {} });
  const first = contents(panel).join(' ');
  assert.match(first, /等待来源事件/);
  assert.match(first, /unpaid/);
  assert.match(first, /等候出票/);
  assert.match(first, /RefreshFliggyFlightBooking/);
  await f.buttons.get('只看跟进缺口')!.click!();
  assert.match(contents(panel).join(' '), /本页没有中断/);
  await f.buttons.get('下一页跟进')!.click!();
  assert.deepEqual(f.events.at(-1), { name: 'observation_interests', input: { cursor: 'page2' } });
  const gap = contents(panel).join(' ');
  assert.match(gap, /跟进中断/);
  assert.match(gap, /后台检查不存在/);
  assert(!gap.includes('停止跟进'));
  const ro = setup(['ontology:read']);
  await renderInterestList(ro.ui, node());
  assert(!ro.buttons.has('停止跟进'));
  await renderInterestList(f.ui, panel);
  await f.buttons.get('停止跟进')!.click!();
  assert(f.events.some((x) => x.name === 'cancel_observation_interest' && x.input.id === 'interest-id'));
});

test('an original object with no prior observations can authorize flight handoff only after reviewing its exact sources, budget and scope', async () => {
  const { showObjectInterests } = await import(moduleUrl),
    f = setup();
  await showObjectInterests(f.ui, processModel, object);
  assert.equal(f.events[0]!.name, 'read_object');
  assert.equal(f.events[1]!.name, 'observation_interests');
  assert.match(contents(f.dialog()).join(' '), /没有可见的跟进记录/);
  await f.buttons.get('开始后台跟进')!.click!();
  await assert.rejects(f.buttons.get('核对跟进范围')!.click!(), /截止时间/);
  f.fields.get('授权截止')!.value = soon;
  await f.buttons.get('核对跟进范围')!.click!();
  assert.equal(f.events.at(-1)!.name, 'prepareBookedFlightWatch');
  assert(!f.events.some((x) => x.name === 'start_observation_interest'));
  assert.match(contents(f.dialog()).join(' '), /VariFlight/);
  assert.match(contents(f.dialog()).join(' '), /最多 8 次/);
  await f.buttons.get('确认并开始跟进')!.click!();
  const saved = f.events.find((x) => x.name === 'start_observation_interest')!.input;
  assert.deepEqual(saved.object, object);
  assert.equal(saved.phases.length, 2);
  assert.equal(saved.phases[0].action, phase.action);
  assert.deepEqual(saved.phases[1].parameters.sources, ['VariFlight']);
  assert.equal(saved.phases[1].parameters.maxChecks, 8);
  assert.equal(saved.phases[1].parameters.bookingDigest, 'a'.repeat(64));
  assert(!('booking' in saved.phases[1].parameters));
  assert.equal(saved.phases[1].parameters.monitorUntil, saved.deadline);
  assert.equal(saved.phases[1].attach.link, 'itineraryWatches');
  const ro = setup(['ontology:read']);
  await showObjectInterests(ro.ui, processModel, object);
  assert(!ro.buttons.has('开始后台跟进'));
});
