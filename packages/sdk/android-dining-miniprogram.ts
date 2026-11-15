import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { SaxesParser } from 'saxes';
import { z } from 'zod';
import { Conflict, digest } from '../core/identity.js';
import { diningMiniProgramRead, diningMiniProgramTarget } from '../ontology/dining-reservations.js';
import type { MiniProgramAvailabilityReader } from './dining-miniprogram-pa.js';

const selector = z.strictObject({
  id: z.string().max(240).optional(), text: z.string().max(240).optional(), description: z.string().max(240).optional(),
}).refine(value => Boolean(value.id || value.text || value.description), 'Use a visible UI selector');
type Selector = z.infer<typeof selector>;
const wechatPackage = 'com.tencent.mm';
const miniProgramActivity = /com\.tencent\.mm\/(?:com\.tencent\.mm)?\.plugin\.appbrand\./;
const loginActivity = /com\.tencent\.mm\/(?:com\.tencent\.mm)?\.plugin\.account\./;
const unsafe = /确认.{0,6}(?:订|约)|立即[预訂订约]|提交|下单|支付|付款|获取手机号|允许|授权|同意|取消.{0,6}(?:订|约)/;
const normalize = (text: string) => text.normalize('NFKC').trim();
export const androidDiningMiniProgram = z.strictObject({
  adb: z.string().refine(isAbsolute),
  serial: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.:-]+$/),
  androidUser: z.number().int().nonnegative(),
  miniProgram: diningMiniProgramTarget,
  dateFormat: z.enum(['iso', 'zh-month-day']).default('iso'),
  screen: z.strictObject({
    identity: selector, branch: selector, date: selector, guests: selector, slots: selector,
    noSlots: selector.optional(),
  }),
  readSteps: z.array(z.strictObject({ from: selector, tap: selector, to: selector })).max(8).default([]),
});
export type AndroidDiningMiniProgram = z.infer<typeof androidDiningMiniProgram>;
type Query = z.infer<typeof diningMiniProgramRead>;
type Node = { attributes: Record<string, string>; parent?: Node };
const exec = promisify(execFile);

function parse(xml: string) {
  const nodes: Node[] = [], stack: (Node | undefined)[] = [];
  const parser = new SaxesParser();
  parser.on('doctype', () => { throw new Conflict('Unexpected document type in Android UI'); });
  parser.on('opentag', tag => {
    const parent = stack.at(-1);
    const node = tag.name === 'node' ? { attributes: tag.attributes, parent } : undefined;
    if (node && node.attributes.package === wechatPackage && node.attributes.password !== 'true') nodes.push(node);
    stack.push(node);
  });
  parser.on('closetag', () => { stack.pop(); });
  parser.write(xml).close();
  return nodes;
}

function labels(query: Query, format: AndroidDiningMiniProgram['dateFormat']) {
  const [year, month, day] = query.date.split('-');
  const now = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: query.miniProgram.timeZone }).format();
  if (format === 'zh-month-day' && year !== now.slice(0, 4))
    throw new Conflict('The configured Android date label needs a visible year for this query');
  return {
    '$branch': query.branch, '$date': format === 'iso' ? query.date : `${Number(month)}月${Number(day)}日`,
    '$guests': `${query.partySize}人`,
  };
}
type Labels = ReturnType<typeof labels>;

function select(nodes: Node[], query: Selector, values: Labels) {
  const resolve = (value: string) => Object.hasOwn(values, value) ? values[value as keyof Labels] : value;
  return nodes.filter(({ attributes: a }) =>
    (!query.id || a['resource-id'] === query.id) &&
    (!query.text || normalize(a.text ?? '') === normalize(resolve(query.text))) &&
    (!query.description || normalize(a['content-desc'] ?? '') === normalize(resolve(query.description))));
}
const exact = (nodes: Node[], query: Selector, values: Labels) => {
  const matches = select(nodes, query, values);
  return matches.length === 1 ? matches[0] : undefined;
};
const text = (node: Node) => normalize(node.attributes.text || node.attributes['content-desc'] || '');

export function readDiningMiniProgramScreen(xml: string, configuration: AndroidDiningMiniProgram, query: Query) {
  const nodes = parse(xml), values = labels(query, configuration.dateFormat), screen = configuration.screen;
  const shows = (field: Selector, expected: string) => {
    const node = exact(nodes, field, values);
    return node && [node.attributes.text, node.attributes['content-desc']].some(value => normalize(value ?? '') === normalize(expected));
  };
  const targetMatches = digest(query.miniProgram) === digest(configuration.miniProgram)
    && shows(screen.identity, query.miniProgram.name)
    && shows(screen.branch, values.$branch)
    && shows(screen.date, values.$date)
    && shows(screen.guests, values.$guests);
  const root = exact(nodes, screen.slots, values);
  if (!targetMatches || !root || root.attributes.enabled === 'false') return;
  const times = new Set<string>();
  for (const node of nodes) {
    const label = text(node);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(label)) continue;
    let current: Node | undefined = node, selectable = false;
    while (current && current !== root && current.attributes.enabled === 'true') {
      if (current.attributes.clickable === 'true' && !/已满|约满|不可订/.test(current.attributes['content-desc'] ?? ''))
        selectable = true;
      current = current.parent;
    }
    if (current === root && selectable) times.add(label);
  }
  const empty = screen.noSlots && exact(nodes, screen.noSlots, values);
  if (Boolean(times.size) === Boolean(empty)) return;
  return [...times].sort();
}

export function androidDiningReader(configuration: AndroidDiningMiniProgram): MiniProgramAvailabilityReader {
  return async (query, signal) => {
    if (digest(configuration.miniProgram) !== digest(query.miniProgram))
      return { status: 'unavailable', reason: 'venue-not-connected' };
    const adb = (...args: string[]) => exec(configuration.adb, ['-s', configuration.serial, ...args], {
      signal, timeout: 12000, maxBuffer: 2_000_000,
    }).then(result => result.stdout);
    const foreground = async () => {
      const current = (await adb('shell', 'am', 'get-current-user')).trim();
      if (current !== String(configuration.androidUser)) throw new Conflict('The Android user changed');
      const state = await adb('shell', 'dumpsys', 'activity', 'activities');
      return state.split('\n').find(line => /topResumedActivity|mResumedActivity/.test(line) && line.includes('ActivityRecord')) ?? '';
    };
    const capture = async () => {
      if (!miniProgramActivity.test(await foreground())) throw new Conflict('Open the configured WeChat mini program');
      const remote = '/data/local/tmp/eigos-dining-' + randomUUID() + '.xml';
      try {
        await adb('shell', 'uiautomator', 'dump', remote);
        const xml = await adb('exec-out', 'cat', remote);
        if (!miniProgramActivity.test(await foreground())) throw new Conflict('The WeChat mini program changed');
        return xml;
      } finally {
        await exec(configuration.adb, ['-s', configuration.serial, 'shell', 'rm', remote],
          { timeout: 4000 }).catch(() => {});
      }
    };
    try {
      const screen = await foreground();
      if (loginActivity.test(screen)) return { status: 'unavailable', reason: 'login-required' };
      if (!miniProgramActivity.test(screen)) return { status: 'unavailable', reason: 'unsupported-screen' };
      const values = labels(query, configuration.dateFormat);
      let xml = await capture();
      for (const step of configuration.readSteps) {
        const nodes = parse(xml);
        if (!exact(nodes, step.from, values)) continue;
        const target = exact(nodes, step.tap, values);
        let control = target;
        while (control && control.attributes.clickable !== 'true') control = control.parent;
        const bounds = control?.attributes.bounds?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
        if (!target || !control || !bounds || control.attributes.enabled !== 'true' || control.attributes.package !== wechatPackage ||
            unsafe.test(text(target) + text(control) + (control.attributes['content-desc'] ?? '')))
          throw new Conflict('The configured query control is unavailable');
        const [, x1, y1, x2, y2] = bounds.map(Number);
        if (x1! >= x2! || y1! >= y2!) throw new Conflict('The query control has no visible area');
        await adb('shell', 'input', 'tap', String(Math.floor((x1! + x2!) / 2)), String(Math.floor((y1! + y2!) / 2)));
        await delay(350, undefined, { signal });
        xml = await capture();
        if (!exact(parse(xml), step.to, values)) throw new Conflict('The query opened an unexpected screen');
      }
      const availableTimes = readDiningMiniProgramScreen(xml, configuration, query);
      return availableTimes === undefined ? { status: 'unavailable', reason: 'unsupported-screen' } :
        { ...query, status: 'observed', evidence: 'pa_reported', availableTimes, observedAt: new Date().toISOString() };
    } catch {
      signal.throwIfAborted();
      return { status: 'unavailable', reason: 'page-unavailable' };
    }
  };
}
