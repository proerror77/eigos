import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { DomainError } from '../../core/domain.js';
import type { ModelDefinition, PropertyDefinition } from '../model.js';
import type { JsonSchema } from '../definition-contracts.js';

// Named predecessor contracts, not a second active ontology. Only these exact
// changes can reuse the current trusted implementation behind the old guard.
const properties: Record<string, [string, string]> = {
  'BookingOffers.data': ['32459c2450cf96d578ba650c0327aebc27cbf2d9e313aa135dcf1d38f814c138', '6e6317e06fd3bd4be401890ed1e1e46e8352ea396746b2a0de71ac4a7d9c08a2'],
  'BookingObservation.data': ['6175bbaf0ddbba9cadec88df3649747174576c647429a81310874fca5a58dfea', 'e0157044e6ad56a337a9f561a06a6b4c16ab1280f07a4fd616537da4bfe29928'],
  'BookingPaymentObservation.data': ['2043db353f3e33f44dda50d8c10e02b8bb83b0ca0b3c3676852f9ca8bc4b3800', 'eaf07731a8b9c3ae1856581410a28ae808a78dcb456bdbdf55b47dd0f1caa275'],
};
const actions: Record<string, [string, string]> = {
  SearchPublicCatalog: ['29f5f43fb0771f77cf29db54d6fbf9d838f9e67a2eba3ca99c4fff35f40c2cf9', '022749a2c62674c770a49db422f96846c63d4e2885dd7393a5e14259f42697b7'],
  InspectCatalogVariant: ['b91606f83d08664a1e81716bca1ebc29a7537140964d048c00255806e881f430', '5a75a7d70c068029a4f466b3ad25123259081b7ff06e5b3c17712ca0d24cbbbd'],
  DiscoverMerchantCatalog: ['f2c7c4b6c82746cbe9ffc8f0a206fdfc38f4f6388b52f8714230db2cd2322597', 'de11eb965ef7869221d9f0b407167506facf900ef59b5bcdc84432c545f8a533'],
  ReadMerchantVariants: ['72811084b6a77f9ce411175196515064a9b4e2b1aaec31010cc774662b2bf0a8', '03bc423f6ef4701d787a18d9ca688130c5f1c4f097521727c4825815adec0d85'],
};
type HistoricalDefinition = {
  objects: { id: string; properties: Record<string, { schema: JsonSchema }> }[];
  actions: ModelDefinition['actions'];
};
function checked(pin: [string, string], old: unknown, current: unknown) {
  if (digest(old) !== pin[0] || digest(current) !== pin[1]) throw new DomainError('CONFLICT', 'A named consolidation predecessor contract changed');
}

export function predecessorImplementation(current: ModelDefinition, historical: HistoricalDefinition): ModelDefinition {
  return { ...current, objects: current.objects.map(type => ({ ...type, properties: Object.fromEntries(Object.entries(type.properties).map(([name, definition]) => {
    const pin = properties[`${type.id}.${name}`];
    if (!pin) return [name, definition];
    const schema = historical.objects.find(value => value.id === type.id)!.properties[name]!.schema;
    checked(pin, schema, definition.schemaMetadata ?? z.toJSONSchema(definition.schema));
    const guard = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
    const validator = definition.schema.superRefine((value, context) => {
      if (!guard.safeParse(value).success) context.addIssue({ code: 'custom', message: 'Value is outside the historical booking contract' });
    });
    return [name, { ...definition, schema: validator, schemaMetadata: schema } satisfies PropertyDefinition];
  })) })), actions: current.actions.map(action => {
    const pin = actions[action.id];
    if (!pin) return action;
    const previous = historical.actions.find(value => value.id === action.id)!;
    checked(pin, previous, action);
    return previous;
  }) };
}
