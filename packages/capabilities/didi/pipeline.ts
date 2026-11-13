import { digest } from '../../core/identity.js';
import { objectRefSchema, type ObjectRef } from '../../ontology/schema.js';
import { Database } from '../../runtime/database.js';
import { Actions } from '../../runtime/actions.js';
import { ingest } from '../../runtime/ingestion.js';
import { Sources, type SourceProjection } from '../../runtime/sources.js';
import { rideFunctions, sourceResultSchema, type SourceResolver } from './functions.js';
import { prepareRideInquiry, resolveRideLocations } from './inquiry.js';
import type { Ontology } from '../../ontology/model.js';

/** DiDi's source normalization and Object Data Funnel. It does not choose an operation. */
export function rideCapabilities(db: Database, resolve: SourceResolver) {
  let sources: Sources;
  const functions = rideFunctions(resolve, new Map([
    ['resolveRideLocations', resolveRideLocations],
    ['prepareRideInquiry', prepareRideInquiry(() => sources, () => functions)],
  ]));
  const projection: SourceProjection = {
    async assertCurrent(owner) { await (await resolve(owner)).assertCurrent(); },
    async apply(graph, source, input, raw) {
      const result = sourceResultSchema.parse(raw), receipt: ObjectRef = { type: 'SourceReceipt', id: result.receipt.id };
      await graph.create(receipt, { id: receipt.id, name: result.receipt.tool, bindingId: result.receipt.bindingId, tool: result.receipt.tool,
        observedAt: result.receipt.receivedAt, evidence: result.evidence, contentDigest: result.receipt.resultDigest });
      if (result.data.kind === 'places' && source === 'DidiPlaces') {
        const rows = result.data.places.map(place => ({ id: digest([result.receipt.bindingId, place.id]), name: place.name, city: place.city,
          address: place.addressAll || place.address || place.name, coordinates: { lat: place.lat, lng: place.lng }, coordinateSystem: place.coordinateSystem,
          sourceBinding: result.receipt.bindingId, observedAt: result.receipt.receivedAt }));
        const objects = await ingest(graph, graph.model, source, rows);
        await graph.linkBatch(objects.map(ref => ({ type: 'PlaceSource', from: ref, to: receipt })));
        return { receipt, objects };
      }
      if (result.data.kind !== 'estimate' || source !== 'DidiEstimates') throw new Error('Datasource response differs from its mapping');
      if (!result.data.items.length) throw new Error('Provider returned no estimates');
      const request = objectRefSchema.parse(input.request ?? { type: 'RideRequest', id: input.requestId });
      if (input.origin && input.destination) {
        const routes = await graph.follow(request, 'route');
        if (routes.length !== 1) throw new Error('Estimate requires one request route');
        const [origin, destination] = await Promise.all([graph.follow(routes[0]!.ref, 'origin', 'RideEstimatable'), graph.follow(routes[0]!.ref, 'destination', 'RideEstimatable')]);
        if (origin.length !== 1 || destination.length !== 1 || digest(origin[0]!.ref) !== digest(input.origin) || digest(destination[0]!.ref) !== digest(input.destination)) throw new Error('Quote endpoints differ from its request');
      }
      const rows = result.data.items.map(item => ({ id: digest([receipt.id, item.productCategory]), name: item.productName, productCategory: item.productCategory,
        priceText: item.priceText, estimatedAmount: item.estimatedMoney ? `${BigInt(item.estimatedMoney.minor) / 100n}.${String(BigInt(item.estimatedMoney.minor) % 100n).padStart(2, '0')}` : null,
        currency: 'CNY', feesComplete: 'unknown', observedAt: result.receipt.receivedAt, expiresAt: new Date(Date.parse(result.receipt.startedAt) + 300000).toISOString() }));
      const objects = await ingest(graph, graph.model, source, rows);
      await graph.linkBatch(objects.flatMap(ref => [{ type: 'EstimateRequest', from: ref, to: request }, { type: 'EstimateSource', from: ref, to: receipt }]));
      const current = await graph.read(request);
      if (current.properties.status !== 'quoted') await graph.edit(request, current.revision, { status: 'quoted' });
      return { receipt, objects, request };
    },
  };
  sources = new Sources(db, functions, new Map(['DidiPlaces', 'DidiEstimates'].map(name => [name, projection])));
  return { functions, actions: new Actions(db, functions), sources, describe: (model: Ontology) => ({ functions: functions.bindings(model), sources: sources.bindings(model) }) };
}
