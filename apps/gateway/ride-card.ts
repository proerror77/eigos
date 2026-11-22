import { readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { sourceResultSchema } from '../../packages/capabilities/didi/functions.js';
import { Conflict, InvalidInput } from '../../packages/core/identity.js';
import { rideWatchRead, rideWatchType } from '../../packages/ontology/ride-watch.js';
import { publicError } from './public-error.js';

const resourceUri = 'ui://eigos/didi-ride-card.html';
const mimeType = 'text/html;profile=mcp-app';
const html = readFileSync(new URL('./ride-card.html', import.meta.url), 'utf8');
const watchRef = z.strictObject({ type: z.literal(rideWatchType), id: z.string().min(1).max(256) });
const quoteRef = z.strictObject({ type: z.literal('RideRequest'), id: z.string().min(1).max(256) });
const inputSchema = z.strictObject({ taskId: z.uuid().optional(), quote: quoteRef.optional(), watch: watchRef.optional() });
const place = z.object({ name: z.string().min(1) });
const fare = z.object({ properties: z.object({
  name: z.string().min(1), priceText: z.string(), currency: z.literal('CNY'), expiresAt: z.iso.datetime(),
}) });
const quoteResult = z.object({
  request: z.object(quoteRef.shape),
  route: z.object({ origin: place, destination: place }),
  estimates: z.array(fare).min(1),
  evidence: z.array(sourceResultSchema.shape.evidence).min(1),
});
const statusLabel = {
  watching: '等待滴滴更新', matching: '正在匹配司机', driver_assigned: '司机正在来接你',
  driver_arrived: '司机已到上车点', in_trip: '行程中', completed: '行程已完成',
  provider_terminal: '订单状态待核实', unavailable: '暂时无法更新', stopped: '已停止跟踪', expired: '跟踪已到期',
} satisfies Record<z.infer<typeof rideWatchRead>['state'], string>;

function fareText(price: string) {
  const text = price.trim();
  return /^\d+(?:\.\d+)?$/.test(text) ? `¥${text}` : text || '暂无报价';
}

function quoteCard(raw: unknown) {
  const result = quoteResult.safeParse(raw);
  if (!result.success) throw new Conflict('The original ride quote is unavailable');
  const { route, estimates, evidence } = result.data;
  const simulated = evidence.some(value => value !== 'live_readonly');
  const prices = estimates.map(({ properties }) => ({
    name: properties.name, fare: fareText(properties.priceText), expiresAt: properties.expiresAt,
  }));
  const now = Date.now();
  const describe = ({ name, fare, expiresAt }: typeof prices[number]) =>
    `${name} ${fare}（${new Date(expiresAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} 到期${Date.parse(expiresAt) <= now ? '，已过期' : ''}）`;
  return {
    data: { kind: 'quote', origin: route.origin.name, destination: route.destination.name, currency: 'CNY', simulated, prices },
    text: `${simulated ? '模拟报价' : '滴滴参考价'} · ${route.origin.name} → ${route.destination.name}\n${prices.map(describe).join('\n')}\n实际车费以滴滴结算为准。`,
  };
}

function watchCard(raw: unknown) {
  const watch = rideWatchRead.parse(raw);
  const status = statusLabel[watch.state];
  const driver = watch.driver && { carModel: watch.driver.carModel, carPlate: watch.driver.carPlate };
  const text = [
    status, driver?.carModel, driver?.carPlate,
    watch.etaMinutes !== null ? `预计 ${watch.etaMinutes} 分钟` : null,
    watch.distanceKm !== null ? `约 ${watch.distanceKm} 公里` : null,
    watch.observedAt && `滴滴更新于 ${new Date(watch.observedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`,
    watch.state === 'completed' && '车费结算待核实',
  ].filter(Boolean).join(' · ');
  return {
    data: {
      kind: 'watch', state: watch.state, status, driver, etaMinutes: watch.etaMinutes, distanceKm: watch.distanceKm,
      observedAt: watch.observedAt, expiresAt: watch.expiresAt, nextCheckAt: watch.nextCheckAt, refresh: { watch: watch.watch },
    },
    text,
  };
}

export const rideCardInstructions = 'For a DiDi fare result, call show_didi_ride with its original taskId or returned RideRequest reference to display the card in this conversation. For an existing ride with a DidiRideWatch reference, use the same tool to show progress. Deliver the returned facts in chat when the host cannot render the card.';

export function registerRideCard(server: McpServer, readers: {
  task: (id: string) => Promise<{ state: string; result: unknown }>;
  quote: (quote: z.infer<typeof quoteRef>) => Promise<unknown>;
  watch: (watch: z.infer<typeof watchRef>) => Promise<unknown>;
}) {
  server.registerResource('didi_ride_card', resourceUri, { mimeType, title: '滴滴行程' }, async () => ({
    contents: [{ uri: resourceUri, mimeType, text: html }],
  }));
  server.registerTool('show_didi_ride', {
    title: '滴滴报价与行程',
    description: 'Return a ride card and a text fallback from exactly one reference: a completed DiDi quote taskId, a quoted RideRequest, or an existing DidiRideWatch. Reads current authorized data. Never starts a ride, a quote, or a watch.',
    inputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri } },
  }, async ({ taskId, quote, watch }) => {
    try {
      if ([taskId, quote, watch].filter(Boolean).length !== 1) throw new InvalidInput('Use exactly one original ride reference');
      let card;
      if (watch) card = watchCard(await readers.watch(watch));
      else if (quote) card = quoteCard(await readers.quote(quote));
      else {
        const task = await readers.task(taskId!);
        if (task.state !== 'completed') throw new Conflict('Wait for the original ride quote to complete');
        card = quoteCard(task.result);
      }
      return { content: [{ type: 'text', text: card.text }], structuredContent: card.data };
    } catch (error) {
      const { status, message, requestId } = publicError(error);
      return {
        isError: true, content: [{ type: 'text', text: message }],
        structuredContent: { status, error: message, ...(requestId ? { requestId } : {}) },
      };
    }
  });
}
