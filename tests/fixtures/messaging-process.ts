import { messagingGatewayFixture } from './messaging-gateway.js';

const fixture = await messagingGatewayFixture();
const a = await fixture.actor('Process Alice'), b = await fixture.actor('Process Bob');
const ga = await fixture.approve(a), gb = await fixture.approve(b);
process.send?.({ kind: 'ready', base: fixture.base, http: fixture.http, a: { token: a.token, endpointId: ga.id }, b: { token: b.token, endpointId: gb.id } });
process.on('message', async input => {
  if (!input || typeof input !== 'object' || !('command' in input)) return;
  if (input.command === 'restart') {
    await fixture.restart(); process.send?.({ kind: 'restarted', http: fixture.http });
  } else if (input.command === 'counts') {
    process.send?.({ kind: 'counts', a: fixture.gateway.store.list(a.owner, { limit: 1, offset: 0 }).total, b: fixture.gateway.store.list(b.owner, { limit: 1, offset: 0 }).total });
  } else if (input.command === 'stop') {
    await fixture.close(); process.disconnect();
  }
});
