import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GoogleCalendarReminders } from '../packages/sdk/google-calendar-reminders.js';
import type { OntologyClient } from '../packages/sdk/client.js';

test('PA calendar reminders replace the same popup, withdraw it and ignore an older retry', async () => {
  const ref = { type: 'CalendarJourney', id: 'selected-trip' };
  const at = (minutes: number) => new Date(Date.now() + minutes * 60000).toISOString();
  const receipt = {
    journey: ref, revision: 1, state: 'scheduled', reason: 'route_checked', checkedAt: at(0),
    nextCheckAt: at(5), validUntil: at(20), timing: null, reminderVersion: 1,
    reminder: { version: 1, prepareAt: at(9), state: 'scheduled', cause: 'initial' } as Record<string, unknown> | null,
    destination: { name: 'Test calendar event', start: at(15) }, calendarEvidence: 'synthetic',
    routeFetchedAt: at(0), weatherCondition: null,
  };
  const client = { evaluate: async (name: string, args: Record<string, unknown>) => {
    assert.equal(name, 'readCalendarJourney');
    assert.deepEqual(args, { journey: ref });
    return structuredClone(receipt);
  } } as Pick<OntologyClient, 'evaluate'>;
  const events = new Map<string, Record<string, unknown>>();
  const mutations: string[] = [];
  const transport: typeof fetch = async (url, request) => {
    const target = new URL(String(url)), headers = new Headers(request?.headers);
    assert.equal(target.origin, 'https://www.googleapis.com');
    assert.equal(headers.get('Authorization'), 'Bearer test-local-calendar-token');
    assert.equal(request?.redirect, 'error');
    if (request?.method === 'GET') {
      const property = target.searchParams.get('privateExtendedProperty');
      assert(property?.startsWith('eigosReminder='));
      return Response.json({ items: [...events.values()] });
    }
    assert.equal(target.searchParams.get('sendUpdates'), 'none');
    mutations.push(request?.method ?? 'unexpected');
    const current = events.get(target.pathname.split('/').at(-1)!);
    if (current) assert.equal(headers.get('If-Match'), current.etag);
    if (request?.method === 'DELETE') {
      events.delete(String(current?.id));
      return new Response(null, { status: 204 });
    }
    const body = JSON.parse(String(request?.body));
    assert.equal(body.attendees, undefined);
    assert.equal(body.visibility, 'private');
    assert.equal(body.transparency, 'transparent');
    assert.deepEqual(body.reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] });
    const saved = { ...current, ...body, etag: String(mutations.length), status: 'confirmed' };
    events.set(saved.id, saved);
    return Response.json(saved);
  };
  const notifier = new GoogleCalendarReminders({ calendarId: 'user-owned-calendar', accountKey: 'private-pa',
    accessToken: () => 'test-local-calendar-token', fetch: transport });
  assert.equal(await notifier.sync(client, ref), 'scheduled');
  const eventId = [...events.keys()][0]!;
  assert.equal(await notifier.sync(client, ref), 'unchanged');
  const earlier = at(5), old = structuredClone(receipt);
  receipt.revision = 2;
  receipt.reminderVersion = 2;
  receipt.reminder = { version: 2, prepareAt: earlier, state: 'scheduled', cause: 'calendar_changed' };
  assert.equal(await notifier.sync(client, ref), 'replaced');
  assert.deepEqual((events.get(eventId)?.start as {dateTime: string}).dateTime, earlier);
  const stale = { evaluate: async () => structuredClone(old) } as Pick<OntologyClient, 'evaluate'>;
  assert.equal(await notifier.sync(stale, ref), 'superseded');
  receipt.revision = 3;
  receipt.reminderVersion = 3;
  receipt.reminder = null;
  receipt.state = 'canceled';
  receipt.reason = 'calendar_canceled';
  assert.equal(await notifier.sync(client, ref), 'withdrawn');
  assert.equal(await notifier.sync(client, ref), 'unchanged');
  assert.equal(events.size, 0);
  assert.deepEqual(mutations, ['POST', 'PATCH', 'DELETE']);
});
