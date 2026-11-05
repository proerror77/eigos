import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRelayNotifications } from '../packages/relay/notifications.js';
import { cloudflareRelayNotifications, RelayNotificationObject } from '../apps/relay/cloudflare-notifications.js';

async function prompt(operation: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Missed notification wakeup')), 5000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

test('notification registration closes the read-to-wait race and releases aborts', async () => {
  const channel = new MemoryRelayNotifications(), revision = await channel.snapshot();
  await channel.notify();
  await prompt(channel.wait(revision, 25000)); // A lost wake must not pass by waiting out the timeout.
  const controller = new AbortController(), next = await channel.snapshot();
  const waiting = channel.wait(next, 25000, controller.signal); controller.abort(); await prompt(waiting);
  const wake = channel.wait(await channel.snapshot(), 25000); await channel.notify(); await prompt(wake);
});

test('one private CF coordinator survives an epoch change without storing message facts', async () => {
  let object = new RelayNotificationObject(); const names: string[] = [];
  const channel = cloudflareRelayNotifications({ idFromName(name) { names.push(name); return name; }, get() { return { fetch: request => object.fetch(request) }; } });
  const revision = await channel.snapshot(); object = new RelayNotificationObject();
  await prompt(channel.wait(revision, 25000));
  const waiting = channel.wait(await channel.snapshot(), 25000); await channel.notify(); await prompt(waiting);
  assert.deepEqual(names, ['relay-notifications']);
  assert.equal((await object.fetch(new Request('https://internal/v1/inbox'))).status, 404);
  assert.equal((await object.fetch(new Request('https://internal/wait', { method: 'POST', body: JSON.stringify({ revision, milliseconds: 25001 }) }))).status, 400);
});
