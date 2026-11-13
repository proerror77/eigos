import { Conflict, NotFound, digest } from '../../core/identity.js';
import { objectRefSchema, type ObjectRef } from '../../ontology/schema.js';
import { serviceCatalog } from '../../ontology/services.js';
import {
  attachServiceInput,
  readServiceInput,
  serviceObservation,
  lumaPAResponse,
  json,
  type ServiceName,
} from '../../ontology/service-contracts.js';
import type { FunctionHandler, FunctionContext } from '../../runtime/functions.js';
import type { SourceProjection, Sources } from '../../runtime/sources.js';
import { ServiceAuthorizationRequired, type ServiceResolver } from './sources.js';
import { PARequests } from '../../runtime/pa.js';

async function currentSource(resolve: ServiceResolver, owner: string, provider: ServiceName) {
  try {
    return await resolve(owner, provider);
  } catch (error) {
    if (provider === 'Luma' && error instanceof ServiceAuthorizationRequired) return;
    throw error;
  }
}
export async function assertServiceAuthority(
  resolve: ServiceResolver,
  owner: string,
  provider: ServiceName,
  bindingId?: string,
) {
  const source = await currentSource(resolve, owner, provider);
  if (source && bindingId && source.bindingId !== bindingId) throw new Conflict('Service source account changed');
  if (!source && bindingId && !/^pa-[a-f0-9]{64}$/.test(bindingId))
    throw new Conflict('The previous service connection is unavailable; obtain a new PA observation');
  await source?.assertCurrent();
}

export async function currentService(objects: FunctionContext['objects'], ref: ObjectRef, expectedSource?: ObjectRef) {
  if (!objects.model.implements(ref.type, 'ServiceOffering')) throw new Conflict('A ServiceOffering is required');
  const item = await objects.read(ref),
    p = item.properties;
  objects.access.source(objects.model, String(p.provider));
  const source = await objects.follow(ref, 'source', 'ServiceOffering');
  if (expectedSource && (source.length !== 1 || digest(source[0]!.ref) !== digest(expectedSource)))
    throw new Conflict('Search page was superseded; read the current service or refresh this query');
  if (
    source.length !== 1 ||
    source[0]!.properties.bindingId !== p.bindingId ||
    source[0]!.properties.observedAt !== p.observedAt ||
    !Number.isFinite(Date.parse(String(p.observedAt))) ||
    !Number.isFinite(Date.parse(String(p.expiresAt))) ||
    Date.parse(String(p.expiresAt)) <= Date.now() ||
    Date.parse(String(p.observedAt)) > Date.now() + 5000
  )
    throw new Conflict('Service observation is stale or lacks source evidence');
  return item;
}
export function serviceFunctions(resolve: ServiceResolver, getSources: () => Sources) {
  const handlers = new Map<string, FunctionHandler>();
  for (const service of serviceCatalog) {
    const provider = service.provider;
    handlers.set(service.read, async (input, context) => {
      const source = await currentSource(resolve, context.principal.owner, provider);
      if (!source) {
        const execution = context.execution;
        if (!execution) throw new Conflict('Luma MCP access requires the original PA task');
        const response = lumaPAResponse.parse(
          await new PARequests(execution.tasks).request(
            execution.task,
            `luma-read:${digest(input)}:${execution.task.execution_step ?? 0}`,
            'luma.events.read',
            {
              ...input,
              fields: ['identity', 'name', 'times', 'location', 'registrationTerms', 'activeOrCanceledStatus'],
              instruction:
                'Use the PA-connected Luma MCP. Preserve native event identity and hidden/coarse locations. Report unknown when current active/canceled status cannot be established. Return only current source facts, and retain pagination; do not call organizer write tools.',
            },
            json(lumaPAResponse),
          ),
        );
        if (response.status !== 'available') throw new Conflict(`Luma PA source is ${response.status}`);
        if (response.items.length > Number(input.limit))
          throw new Conflict('PA result exceeds the requested page limit');
        if (input.eventId && (response.items.length !== 1 || response.items[0]!.nativeId !== input.eventId))
          throw new Conflict('PA returned a different Luma event');
        const result = { items: response.items, complete: response.complete, cursor: response.cursor };
        return serviceObservation.parse({
          provider: 'Luma',
          bindingId: `pa-${digest([context.principal.owner, response.accountRef])}`,
          observedAt: response.observedAt,
          expiresAt: response.expiresAt,
          evidence: 'pa_reported',
          proofDigest: response.proofDigest,
          ...result,
          inputDigest: digest(input),
          contentDigest: digest(result),
        });
      }
      await source.assertCurrent();
      const result = serviceObservation.parse(await source.read(input, context.signal));
      await source.assertCurrent();
      if (result.provider !== provider || result.bindingId !== source.bindingId || result.inputDigest !== digest(input))
        throw new Conflict('Source result identity mismatch');
      return result;
    });
    handlers.set(service.search, async (input, context) => {
      if (!context.edit || context.objects.model.scenario)
        throw new Conflict('Read services into live Ontology before scenario planning');
      const source = service.source,
        execution = context.execution;
      const result = serviceObservation.parse(
        await getSources().read(
          context.objects.model,
          source,
          input,
          context.objects.access,
          execution?.task,
          execution?.tasks,
          context.signal,
        ),
      );
      const root = { type: service.result, id: digest(result) };
      return context.edit(root, async (graph) => {
        const projected = await getSources().project(graph, source, input, result, context.signal);
        if (digest(projected.receipt) !== digest(root)) throw new Conflict('Service projection identity changed');
      });
    });
  }
  handlers.set('readServiceOffering', async (input, context) => {
    const item = await currentService(context.objects, readServiceInput.parse(input).service);
    await assertServiceAuthority(
      resolve,
      context.principal.owner,
      item.properties.provider as ServiceName,
      String(item.properties.bindingId),
    );
    return item;
  });
  handlers.set('readServiceSearch', async (input, context) => {
    const ref = objectRefSchema.parse(input.search);
    if (!context.objects.model.implements(ref.type, 'ServiceSearchResult'))
      throw new Conflict('Expected ServiceSearchResult');
    const search = await context.objects.read(ref),
      provider = search.properties.provider as ServiceName;
    context.objects.access.source(context.objects.model, provider);
    await assertServiceAuthority(resolve, context.principal.owner, provider, String(search.properties.bindingId));
    if (ms(search.properties.expiresAt) <= Date.now()) throw new Conflict('Service result page expired');
    const items = await context.objects.follow(ref, 'results', 'ServiceSearchResult');
    for (const item of items) await currentService(context.objects, item.ref, ref);
    return {
      search,
      items,
      complete: search.properties.complete,
      cursor: search.properties.cursor,
      evidence: search.properties.evidence,
    };
  });
  handlers.set('evaluateServiceOffering', async (input, context) => {
    const item = await currentService(context.objects, readServiceInput.parse(input).service),
      p = item.properties;
    await assertServiceAuthority(resolve, context.principal.owner, p.provider as ServiceName, String(p.bindingId));
    let planning: 'available' | 'unavailable' | 'unknown' = 'available',
      commitment: 'requires_authorization' | 'unavailable' | 'unknown' = 'unknown';
    const reasons: string[] = [];
    if (context.objects.model.implements(item.ref.type, 'AttendableEvent')) {
      if (p.status === 'canceled' || ms(p.end) <= Date.now()) planning = 'unavailable';
      else if (p.status !== 'active') planning = 'unknown';
      if (p.locationPrecision !== 'exact') reasons.push('exact_venue_required_for_travel');
      commitment =
        p.registrationOpen === true && planning === 'available'
          ? 'requires_authorization'
          : planning === 'unknown'
            ? 'unknown'
            : 'unavailable';
      if (p.approvalRequired) reasons.push('host_approval_required');
      reasons.push('exact_ticket_and_participant_terms_required');
    } else if (context.objects.model.implements(item.ref.type, 'HotelOffer')) {
      reasons.push(
        'reference_price_only',
        'room_inventory_and_rate_terms_not_observed',
        'reservation_connector_not_configured',
      );
    } else if (context.objects.model.implements(item.ref.type, 'ProductOffer')) {
      planning = p.available === false ? 'unavailable' : p.available === true ? 'available' : 'unknown';
      reasons.push('delivery_time_unknown', 'merchant_checkout_required');
      if (p.available === false) commitment = 'unavailable';
    }
    return { service: item.ref, planning, commitment, reasons, externalEffect: false };
  });
  handlers.set('attachPlanService', async (raw, context) => {
    const input = attachServiceInput.parse(raw);
    if (!context.edit) throw new Conflict('Use an Action');
    if (context.execution && !context.objects.model.scenario)
      throw new Conflict('Propose service selections in a scenario');
    return context.edit(input.plan, async (graph) => {
      await graph.read(input.plan);
      const service = await currentService(graph, input.service);
      await assertServiceAuthority(
        resolve,
        graph.owner,
        service.properties.provider as ServiceName,
        String(service.properties.bindingId),
      );
      await graph.link({
        type: graph.model.navigation(input.service.type, 'plans', 'ServiceOffering').link,
        from: input.service,
        to: input.plan,
      });
    });
  });
  return handlers;
}
const ms = (value: unknown) => Date.parse(String(value));
export function serviceProjections(resolve: ServiceResolver): ReadonlyMap<string, SourceProjection> {
  return new Map(
    serviceCatalog.map((service) => [
      service.source,
      {
        async assertCurrent(owner: string) {
          await (await currentSource(resolve, owner, service.provider))?.assertCurrent();
        },
        async apply(graph, source, input, raw) {
          const result = serviceObservation.parse(raw),
            { items, ...fields } = result;
          const provider = service.provider;
          await assertServiceAuthority(resolve, graph.owner, provider, result.bindingId);
          if (
            result.provider !== provider ||
            source !== service.source ||
            result.inputDigest !== digest(input) ||
            result.contentDigest !== digest({ items, complete: result.complete, cursor: result.cursor })
          )
            throw new Conflict('Source content changed');
          const observed = Date.parse(result.observedAt),
            expires = Date.parse(result.expiresAt);
          if (
            observed > Date.now() + 5000 ||
            observed < Date.now() - 300000 ||
            expires <= Date.now() ||
            expires > observed + 300000
          )
            throw new Conflict('Service observation expired');
          const receipt = { type: service.result, id: digest(result) };
          const observedAt = new Date(observed).toISOString(),
            expiresAt = new Date(expires).toISOString();
          await graph.create(receipt, {
            id: receipt.id,
            name: `${provider} result page`,
            ...fields,
            observedAt,
            expiresAt,
          });
          const refs = items.map((item) => ({
            type: service.object,
            id: digest([
              provider,
              result.bindingId,
              item.nativeId,
              ...('checkIn' in item ? [item.checkIn, item.nights, item.adults, item.currency] : []),
            ]),
          }));
          if (new Set(items.map((item) => item.nativeId)).size !== items.length)
            throw new Conflict('Duplicate service identity in provider page');
          const batch = items.map((item, i) => ({
            ref: refs[i]!,
            properties: {
              ...item,
              id: refs[i]!.id,
              provider,
              bindingId: result.bindingId,
              observedAt,
              expiresAt,
              evidence: result.evidence,
            },
          }));
          for (const item of batch) {
            const previous = await graph.read(item.ref).catch((error) => {
              if (error instanceof NotFound) return;
              throw error;
            });
            if (previous) {
              if (!Number.isFinite(ms(previous.properties.observedAt)))
                throw new Conflict('Source observation time is unavailable');
              if (
                ms(previous.properties.observedAt) > observed ||
                (ms(previous.properties.observedAt) === observed &&
                  digest(previous.properties) !== digest(item.properties))
              )
                throw new Conflict('An older or conflicting source observation cannot overwrite this service');
              for (const old of await graph.follow(item.ref, 'source', 'ServiceOffering'))
                if (digest(old.ref) !== digest(receipt))
                  await graph.unlink({ type: `${item.ref.type}Source`, from: item.ref, to: old.ref });
            }
          }
          await graph.ingestBatch(batch);
          await graph.linkBatch(refs.map((ref) => ({ type: `${ref.type}Source`, from: ref, to: receipt })));
          await graph.linkBatch(refs.map((ref) => ({ type: `${ref.type}SearchResult`, from: receipt, to: ref })));
          return { receipt, objects: refs };
        },
      },
    ]),
  );
}
