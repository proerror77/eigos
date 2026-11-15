import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { diningMiniProgramRead } from '../ontology/dining-reservations.js';

export const diningVisionScreen = z.strictObject({
  executable: z.string().refine(isAbsolute),
  programLabel: z.string().trim().min(1).max(160),
  branchPrefix: z.string().trim().min(1).max(160),
  bookingLabel: z.string().trim().min(1).max(80),
  noSlotsLabel: z.string().trim().min(1).max(80).optional(),
});
type VisionScreen = z.infer<typeof diningVisionScreen>;
type Query = z.infer<typeof diningMiniProgramRead>;
const linesSchema = z.array(z.strictObject({
  text: z.string().max(500), x: z.number().min(0).max(1), y: z.number().min(0).max(1),
})).max(500);
const normalize = (text: string) => text.normalize('NFKC').replace(/\s/g, '').toLowerCase();

export function readDiningVisionScreen(raw: unknown, config: VisionScreen, query: Query, dateLabel: string) {
  const lines = linesSchema.parse(raw).map(line => ({ ...line, text: normalize(line.text) }));
  if (!lines.some(line => line.y < 0.16 && line.text.includes(normalize(config.programLabel)) && line.text.includes(normalize(query.city))))
    return;
  const summary = lines.filter(line => line.y < 0.35 && /\d{1,2}月\d{1,2}日/.test(line.text) && /\d{1,2}人/.test(line.text));
  if (summary.length !== 1 || summary[0]!.text.match(/\d{1,2}月\d{1,2}日/)?.[0] !== dateLabel ||
      Number(summary[0]!.text.match(/(?<!\d)(\d{1,2})人/)?.[1]) !== query.partySize)
    return;
  const prefix = normalize(config.branchPrefix);
  const headings = lines.filter(line => line.text.startsWith(prefix) && line.y > summary[0]!.y).sort((a, b) => a.y - b.y);
  const matches = headings.filter(line => line.text === normalize(query.branch));
  if (matches.length !== 1) return;
  const branch = matches[0]!, nextBranch = headings[headings.indexOf(branch) + 1];
  const bottom = Math.min(branch.y + 0.20, nextBranch?.y ?? 1);
  const group = lines.filter(line => line.y > branch.y && line.y < bottom);
  const actions = group.filter(line => line.text === normalize(config.bookingLabel));
  const times = group.filter(line => /^([01]\d|2[0-3]):[0-5]\d$/.test(line.text) &&
    actions.some(action => Math.abs(action.x - line.x) < 0.06 && action.y - line.y > 0 && action.y - line.y < 0.065));
  if (times.length) return [...new Set(times.map(line => line.text))].sort();
  if (config.noSlotsLabel && group.some(line => line.text === normalize(config.noSlotsLabel!))) return [];
}

export async function recognizeDiningScreen(path: string, png: Buffer, signal: AbortSignal) {
  return new Promise<unknown>((resolve, reject) => {
    const process = execFile(path, [], { signal, timeout: 10000, maxBuffer: 262144 }, (error, stdout) => {
      if (error) return reject(error);
      try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
    });
    process.stdin?.on('error', reject);
    process.stdin?.end(png);
  });
}
