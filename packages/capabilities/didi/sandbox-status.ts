import { z } from 'zod';

const sandboxText = z.tuple([z.object({ type: z.literal('text'), text: z.string().min(1).max(8000) })]);
const headings = new Map([
  ['系统正在为您匹配最近的司机...', 0],
  ['系统已为您匹配到司机，正在快马加鞭来接您。', 1],
  ['司机已经到达起点附近，请尽快上车。', 2],
  ['行程进行中，请系好安全带', 4],
  ['✅ 行程已完成！', 5],
]);

export function sandboxRideStatus(content: unknown, orderId: string) {
  const [{ text }] = sandboxText.parse(content);
  const [heading, ...lines] = text.trim().split(/\r?\n/).map(line => line.trim());
  const statusCode = headings.get(heading ?? '');
  if (statusCode === undefined) throw new Error('Unrecognized DiDi sandbox status');
  // The sandbox usually omits an ID and can return the latest result for an invalid ID.
  // Its caller must pin the request to the order returned by sandbox creation.
  const reportedOrder = /^(?:订单号|订单编号|订单\s*ID|order_?id)\s*[:：]\s*(.*)$/i;
  for (const line of lines) {
    const match = reportedOrder.exec(line);
    if (match && match[1] !== orderId) throw new Error('Original provider order identity changed');
  }
  const label = (key: string) => lines.find(line => line.startsWith(key))?.slice(key.length).trim().slice(0, 120) || null;
  const name = label('• 称呼：'), carModel = label('• 车型：'), carPlate = label('• 车牌：');
  const distance = /^(?:师傅离上车点还有|离终点还有)：(\d+(?:\.\d+)?)\s*公里，约需(\d+(?:\.\d+)?)分钟到达。$/;
  const eta = lines.map(line => distance.exec(line)).find(match => match !== null);
  return {
    statusCode, driver: name || carModel || carPlate ? { name, carModel, carPlate } : null,
    distanceKm: eta ? Number(eta[1]) : null, etaMinutes: eta ? Number(eta[2]) : null,
  };
}
