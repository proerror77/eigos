import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { RelayClient } from '../packages/agent-transport/client.js';
import { readRelayConfig } from '../apps/relay/config.js';
import { z } from 'zod';

// Synthetic availability exchange: no real calendar or delegated scheduling engine.
const config = readRelayConfig();
if (config.authMode !== 'development') throw new Error('This synthetic example requires a loopback development relay');
const directory = resolve(process.env.EIGOS_RELAY_EXAMPLE_DIRECTORY ?? 'data/relay-example');
const clients: RelayClient[] = [];
const open = async (name: string) => {
  const client = await RelayClient.open({ baseUrl: config.publicUrl, credentialPath: resolve(directory, `${name}.json`), displayName: name });
  clients.push(client); const registration = await client.register(config.devToken!);
  if (registration.expiresAt < Date.now() + 60000) await client.renew(config.devToken!);
  return client;
};
async function connect(a: RelayClient, b: RelayClient) {
  const existing = (await a.contacts()).find(c => c.state === 'accepted' && (c.requester === b.agentId || c.recipient === b.agentId));
  if (existing) return existing.id;
  const pending = (await b.contacts()).find(c => c.state === 'pending' && c.requester === a.agentId) ?? await a.requestContact(b.agentId);
  await b.respondContact(pending.id, 'accept'); return pending.id;
}
const requestSchema = z.strictObject({ kind: z.literal('availability.request'), taskId: z.uuid(), purpose: z.literal('synthetic-meeting'), durationMinutes: z.literal(60) });
const responseSchema = z.strictObject({ kind: z.literal('availability.response'), taskId: z.uuid(), timezone: z.literal('Asia/Shanghai'), slots: z.array(z.string()), expiresAt: z.number() });
try {
  const user = await open('initiator-pa'), eigos = await open('eigos-coordinator'), a = await open('participant-a-pa'), b = await open('participant-b-pa');
  const userLink = await connect(user, eigos), aLink = await connect(eigos, a), bLink = await connect(eigos, b), taskId = randomUUID();
  await user.send(eigos.agentId, userLink, { kind: 'coordinate.request', taskId, participants: [a.agentId, b.agentId], purpose: 'synthetic-meeting' });
  const goal = (await eigos.poll()).find(m => (m.content as { taskId?: string })?.taskId === taskId);
  if (!goal || goal.senderId !== user.agentId) throw new Error('Synthetic request not received');
  eigos.markHandled(goal.senderId, goal.id);
  const query = { kind: 'availability.request', taskId, purpose: 'synthetic-meeting', durationMinutes: 60 };
  await Promise.all([eigos.send(a.agentId, aLink, query), eigos.send(b.agentId, bLink, query)]);
  const answer = async (pa: RelayClient, link: string, localSlots: string[]) => {
    const message = (await pa.poll()).find(m => (m.content as { taskId?: string })?.taskId === taskId);
    if (!message || message.senderId !== eigos.agentId || message.connectionId !== link) throw new Error('Unexpected synthetic requester');
    requestSchema.parse(message.content);
    await pa.send(eigos.agentId, link, { kind: 'availability.response', taskId, timezone: 'Asia/Shanghai', slots: localSlots, expiresAt: Date.now() + 60000 });
    pa.markHandled(message.senderId, message.id);
  };
  await Promise.all([answer(a, aLink, ['fixture-day 14:00', 'fixture-day 16:00']), answer(b, bLink, ['fixture-day 16:00', 'fixture-day 18:00'])]);
  const replies = (await eigos.poll()).filter(m => [a.agentId, b.agentId].includes(m.senderId) && (m.content as { taskId?: string })?.taskId === taskId);
  if (new Set(replies.map(m => m.senderId)).size !== 2) throw new Error('Both participants must respond');
  const answers = replies.map(m => responseSchema.parse(m.content));
  if (answers.some(reply => reply.expiresAt <= Date.now())) throw new Error('Availability expired');
  const slots = answers[0]!.slots.filter(slot => answers[1]!.slots.includes(slot));
  await eigos.send(user.agentId, userLink, { kind: 'coordinate.candidates', taskId, slots, calendarWritten: false, execution: 'synthetic' });
  for (const reply of replies) eigos.markHandled(reply.senderId, reply.id);
  const result = (await user.poll()).find(m => m.senderId === eigos.agentId && (m.content as { taskId?: string })?.taskId === taskId);
  if (!result) throw new Error('Candidate result not received');
  user.markHandled(result.senderId, result.id);
  console.log(JSON.stringify({ protocol: 'eigos.relay.v1', execution: 'synthetic', participants: 3, result: result.content }));
} finally { for (const client of clients) client.close(); }
