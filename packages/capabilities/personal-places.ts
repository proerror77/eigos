import { Conflict, NotFound, digest } from '../core/identity.js';
import {
  currentPersonalPlaceVersionLink, personalPlaceHistoryLink, personalPlaceInput, personalPlaceRecord,
  personalPlaceType, personalPlaceVersionRecord, personalPlaceVersionRef, personalPlaceVersionType,
} from '../ontology/personal-places.js';
import type { ObjectRef } from '../ontology/schema.js';
import type { FunctionContext, FunctionHandler } from '../runtime/functions.js';

export async function currentPersonalPlaceVersion(objects: Pick<FunctionContext['objects'], 'follow'>, place: ObjectRef) {
  const [current] = await objects.follow(place, 'currentVersion');
  if (!current) throw new Conflict('The personal place has no visible confirmed address version');
  return { ...current, ref: personalPlaceVersionRef.parse(current.ref) };
}

export const savePersonalPlace: FunctionHandler = (raw, ctx) => {
  if (!ctx.edit || ctx.objects.model.scenario) throw new Conflict('Save a confirmed personal place in the live Ontology');
  const { role, address, city, expectedRevision } = personalPlaceInput.parse(raw);
  const ref = { type: personalPlaceType, id: digest([ctx.principal.owner, personalPlaceType, role]) };
  const version = expectedRevision + 1;
  const name = role === 'home' ? '家' : '公司';
  const fields = personalPlaceRecord.parse({ id: ref.id, name, role, currentVersionNumber: version });
  return ctx.edit(ref, async graph => {
    const existing = await graph.read(ref).catch(error => {
      if (!(error instanceof NotFound)) throw error;
    });
    if ((existing?.revision ?? 0) !== expectedRevision) throw new Conflict('The saved place changed; read its current revision');
    if (existing) {
      const current = await currentPersonalPlaceVersion(graph, ref);
      const previous = personalPlaceVersionRecord.parse(current.properties);
      if (previous.address === address && previous.city === city) return;
      await graph.unlink({ type: currentPersonalPlaceVersionLink, from: ref, to: current.ref });
      await graph.edit(ref, existing.revision, { currentVersionNumber: version });
    } else {
      await graph.create(ref, fields);
    }
    const snapshot = { type: personalPlaceVersionType, id: digest([ref.id, version]) };
    await graph.create(snapshot, personalPlaceVersionRecord.parse({ id: snapshot.id, role, name, address, city, version }));
    await graph.linkBatch([personalPlaceHistoryLink, currentPersonalPlaceVersionLink].map(type => ({ type, from: ref, to: snapshot })));
  });
};
