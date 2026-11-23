import { z } from 'zod';
import { Conflict, digest } from '../../core/identity.js';
import {
  bindDeliveryAddressInput, deliveryAddressChoice, deliveryAddressList, deliveryAddressNames, deliveryAddressRecord,
  deliveryAddressType, type deliveryDestination,
} from '../../ontology/delivery-addresses.js';
import { localDeliveryProviders, localDeliveryServices, type LocalDeliveryProvider } from '../../ontology/local-delivery.js';
import { currentPersonalPlaceVersion } from '../personal-places.js';
import type { ObjectRef } from '../../ontology/schema.js';
import type { FunctionContext, FunctionHandler } from '../../runtime/functions.js';
import type { Objects } from '../../runtime/objects.js';
import { configuredDelivery, deliveryMcp, DeliveryReadFailure, type DeliveryCall, type DeliveryConnectionPaths } from './mcp.js';

type ProviderAccount = { platformId: 'taobao' | 'hema'; accountRef: string };
type Destination = z.infer<typeof deliveryDestination>;
const sourceRef = z.string().regex(/^[a-f0-9]{64}$/);
const addressChoice = z.object({
  label: deliveryAddressChoice.shape.label,
  address: z.string().trim().max(1100),
  ref: sourceRef, usable: z.boolean(),
});
const sourceAddresses = z.object({
  platformId: z.enum(['taobao', 'hema']), selectedRef: sourceRef.nullable(), addresses: z.array(addressChoice).max(100),
});

async function addressChoices(call: DeliveryCall, account: ProviderAccount, owner: string, provider: LocalDeliveryProvider) {
  const { platformId, selectedRef, addresses } = sourceAddresses.parse(await call('account_addresses', account));
  if (platformId !== account.platformId || new Set(addresses.map(row => row.ref)).size !== addresses.length)
    throw new DeliveryReadFailure('unavailable');
  return addresses.filter(row => row.usable && row.address).map(({ ref, address, label }) => ({
    nativeRef: ref, address, label, selected: ref === selectedRef,
    addressKey: digest([owner, provider, account.accountRef, ref, address]),
  }));
}

function addressObject(addressKey: string) {
  return { type: deliveryAddressType, id: addressKey };
}

export async function persistDeliveryAddress(graph: Objects, address: ObjectRef, provider: LocalDeliveryProvider, text: string) {
  await graph.create(address, deliveryAddressRecord.parse({ id: address.id, provider, address: text,
    name: localDeliveryServices[provider].displayName + '配送地址' }));
}

async function assertPersonalLink(objects: Pick<Objects, 'follow'>, provider: LocalDeliveryProvider, place: ObjectRef, address: ObjectRef) {
  const version = await currentPersonalPlaceVersion(objects, place);
  const links = await objects.follow(version.ref, deliveryAddressNames(provider).personalNavigation);
  if (!links.some(row => row.ref.id === address.id))
    throw new Conflict('The supplier’s selected address is not linked to this personal place. Review the supplier address and select or link the confirmed address.');
  return version.ref;
}

export async function resolveDeliveryDestination(call: DeliveryCall, ctx: FunctionContext, provider: LocalDeliveryProvider,
  account: ProviderAccount, destination: Destination) {
  const selected = (await addressChoices(call, account, ctx.principal.owner, provider)).find(row => row.selected);
  if (!selected) throw new DeliveryReadFailure('address_required');
  const address = addressObject(selected.addressKey);
  const personalVersion = destination.source === 'personal'
    ? await assertPersonalLink(ctx.objects, provider, destination.place, address) : undefined;
  return { address, nativeRef: selected.nativeRef, text: selected.address, personalVersion };
}

export async function confirmDeliveryDestination(call: DeliveryCall, ctx: FunctionContext, provider: LocalDeliveryProvider,
  account: ProviderAccount, address: ObjectRef) {
  const selected = (await addressChoices(call, account, ctx.principal.owner, provider)).find(row => row.selected);
  if (selected?.addressKey !== address.id) throw new DeliveryReadFailure('address_required');
}

export async function recheckPersonalDestination(graph: Objects, provider: LocalDeliveryProvider, destination: Destination,
  address: ObjectRef, version?: ObjectRef) {
  if (destination.source === 'personal' && (await assertPersonalLink(graph, provider, destination.place, address)).id !== version?.id)
    throw new Conflict('The personal delivery address version changed during the search');
}

export function deliveryAddressFunctions(paths: DeliveryConnectionPaths, fetcher: typeof fetch = fetch): ReadonlyMap<string, FunctionHandler> {
  const handlers = new Map<string, FunctionHandler>();
  for (const provider of localDeliveryProviders) {
    const service = localDeliveryServices[provider], names = deliveryAddressNames(provider);
    const choices = async (ctx: FunctionContext) => {
      const conn = await configuredDelivery(paths[provider], provider, ctx);
      const account = { platformId: service.platformId, accountRef: conn.accountRef };
      const addresses = await deliveryMcp(conn, ctx.signal,
        call => addressChoices(call, account, ctx.principal.owner, provider), fetcher);
      await conn.check();
      return { addresses, conn };
    };
    handlers.set(names.list, async (_raw, ctx) => {
      const { addresses } = await choices(ctx);
      return deliveryAddressList.parse({ addresses: addresses.map(({ nativeRef: _native, ...row }) => row) });
    });
    handlers.set(names.editBinding, async (raw, ctx) => {
      if (!ctx.edit || ctx.objects.model.scenario) throw new Conflict('Link a confirmed address in the live Ontology');
      const { place, expectedRevision, addressKey } = bindDeliveryAddressInput.parse(raw);
      const { addresses, conn } = await choices(ctx);
      const selected = addresses.find(row => row.addressKey === addressKey);
      if (!selected)
        throw new Conflict('The reviewed address is no longer available on this supplier account. Read its current addresses again.');
      const address = addressObject(addressKey);
      return ctx.edit(address, async graph => {
        await conn.assertBinding();
        if ((await graph.read(place)).revision !== expectedRevision)
          throw new Conflict('The saved personal place changed after review');
        const snapshot = await currentPersonalPlaceVersion(graph, place);
        await persistDeliveryAddress(graph, address, provider, selected.address);
        await graph.link({ type: names.personalLink, from: snapshot.ref, to: address });
      });
    });
  }
  return handlers;
}
