import { Conflict, NotFound, digest } from '../core/identity.js';
import { personalPlaceInput, personalPlaceRecord, personalPlaceType } from '../ontology/personal-places.js';
import { personalDeliveryLinks } from '../ontology/delivery-addresses.js';
import type { FunctionHandler } from '../runtime/functions.js';

export const savePersonalPlace: FunctionHandler = (raw, ctx) => {
  if (!ctx.edit || ctx.objects.model.scenario) throw new Conflict('Save a confirmed personal place in the live Ontology');
  const { role, address, city, expectedRevision } = personalPlaceInput.parse(raw);
  const ref = { type: personalPlaceType, id: digest([ctx.principal.owner, personalPlaceType, role]) };
  const fields = personalPlaceRecord.parse({ id: ref.id, name: role === 'home' ? '家' : '公司', role, address, city });
  return ctx.edit(ref, async graph => {
    const existing = await graph.read(ref).catch(error => {
      if (!(error instanceof NotFound)) throw error;
    });
    if ((existing?.revision ?? 0) !== expectedRevision) throw new Conflict('The saved place changed; read its current revision');
    if (!existing) {
      await graph.create(ref, fields);
      return;
    }
    const previous = personalPlaceRecord.parse(existing.properties);
    if (previous.address === address && previous.city === city) return;
    for (const { apiName, from } of personalDeliveryLinks) {
      const linked = await graph.follow(ref, from.name);
      for (const row of linked) await graph.unlink({ type: apiName, from: ref, to: row.ref });
    }
    await graph.edit(ref, existing.revision, { address, city });
  });
};
