import { z } from 'zod';
import { Conflict, InvalidInput } from '../../core/identity.js';
import { yuanToFen } from '../../core/private-source.js';
import { deliveryMerchantId } from '../../ontology/local-delivery.js';
import { deliveryHistoryEntry, deliveryItemReport, deliveryLine, deliveryScope } from '../../ontology/local-delivery-trade.js';
import { type DeliveryCall } from './mcp.js';

type Scope = z.infer<typeof deliveryScope>;
export type Channel = Scope['channel'];
export type ProviderOwner = { platformId: 'hema' | 'taobao'; accountRef: string };
const cents = z.number().int().nonnegative().safe();
const short = z.string().max(500);
const nativeOrderId = deliveryHistoryEntry.shape.id;
const nativeAmount = z.union([z.string(), z.number()]).nullish();
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const sourceQuantity = z.union([z.number(), z.string().regex(/^\d+(?:\.\d+)?$/)])
  .transform(Number).pipe(z.number().positive().finite());
const sourceLine = z.object({
  ref: short.optional(), id: short.optional(), name: short.min(1), specification: short.nullish(), quantity: sourceQuantity,
  totalCents: cents.optional(), priceCents: cents.optional(), price: nativeAmount,
});
const cartLine = sourceLine.extend({ selected: z.boolean(), available: z.boolean() });
const paymentState = z.enum(['paid', 'unpaid', 'failed', 'unknown', 'requires-verification', 'unconfirmed']).optional();

export function ownerScope(scope: Scope) {
  if (scope.channel !== 'hema' && !scope.merchantId) throw new InvalidInput('This Taobao service requires a merchantId');
  return scope.merchantId ? { shopId: scope.merchantId } : {};
}

export async function selectedDeliveryAddress(call: DeliveryCall, owner: ProviderOwner) {
  const selected = z.object({ platformId: z.literal(owner.platformId), selectedRef: revision.nullable() })
    .parse(await call('account_addresses', owner)).selectedRef;
  if (!selected) throw new Conflict('Choose a delivery address in the connected dsh-waimai account');
  return selected;
}

export const validCart = z.object({
  platformId: z.enum(['taobao', 'hema']), shopId: deliveryMerchantId.optional(), addressRef: revision,
  revision, items: z.array(cartLine).max(500),
  mutation: z.object({ operationRef: z.uuid().optional(), state: z.string() }).optional(),
});
export type SourceCart = z.infer<typeof validCart>;
export async function readCart(call: DeliveryCall, owner: ProviderOwner, scope: Scope, addressRef: string) {
  const native = scope.channel === 'taobao_retail' ? 'account_retail_cart' : 'account_cart';
  const cart = validCart.parse(await call(native, { ...owner, ...ownerScope(scope), addressRef }));
  if (cart.platformId !== owner.platformId || cart.addressRef !== addressRef || scope.channel !== 'hema' && cart.shopId !== scope.merchantId)
    throw new Conflict('The provider cart belongs to a different account context');
  return cart;
}

export function lineFromSource(line: z.infer<typeof sourceLine>) {
  return deliveryLine.parse({
    name: line.name, specification: line.specification || null, lineId: line.ref ?? line.id ?? null, quantity: line.quantity,
    unitPriceMinor: line.priceCents ?? (line.price == null ? null : yuanToFen(line.price)),
    lineTotalMinor: line.totalCents ?? null,
  });
}

const mealOption = z.object({ ref: revision, name: short.min(1), priceCents: cents, available: z.boolean() });
const mealVariant = mealOption.extend({ stock: z.number().nonnegative(), groups: z.array(z.object({
  name: short.min(1), minimum: z.number().int().nonnegative(), maximum: z.number().int().nonnegative(), choices: z.array(mealOption),
})) });
const detailStock = z.object({ id: nativeOrderId, name: short, minimumQuantity: z.number().positive(),
  stockQuantity: z.number().nonnegative(), quantityStep: z.number().positive() });

/** Resolve a provider item in the current selected address before using any short-lived product reference. */
export async function itemOptions(call: DeliveryCall, owner: ProviderOwner,
  input: Scope & { itemId: string; query?: string }, addressRef: string) {
  const merchantId = input.merchantId;
  if (!merchantId) throw new InvalidInput('Select a merchant from the original search');
  const args = { ...owner, shopId: merchantId, addressRef };
  const base = { channel: input.channel, merchantId, itemId: input.itemId, currency: 'CNY' as const };
  if (input.channel === 'taobao_meal') {
    const detail = z.object({ platformId: z.literal('taobao'), shopId: z.literal(merchantId), addressRef: z.literal(addressRef),
      selectionRef: z.uuid(), itemId: z.literal(input.itemId), name: short.min(1), minimumQuantity: z.number().positive(),
      variants: z.array(mealVariant).max(100),
    }).parse(await call('account_item_options', { ...args, itemId: input.itemId }));
    const report = deliveryItemReport.parse({ ...base, name: detail.name, minimumQuantity: detail.minimumQuantity,
      variants: detail.variants.map(variant => ({
        ref: variant.ref, name: variant.name, listedPriceMinor: variant.priceCents, stockQuantity: variant.stock, available: variant.available,
        groups: variant.groups.map(group => ({ ...group, choices: group.choices.map(choice => ({
          ref: choice.ref, name: choice.name, available: choice.available, amountMinor: choice.priceCents,
        })) })),
      })),
    });
    return { report, selectionRef: detail.selectionRef };
  }
  if (!input.query) throw new InvalidInput('Supply the original keyword of this retail product');
  if (input.channel === 'taobao_retail') {
    const detail = z.object({ platformId: z.literal('taobao'), shopId: z.literal(merchantId), addressRef: z.literal(addressRef), productRef: z.uuid(),
      name: short.min(1), priceCents: cents, stock: z.number().nonnegative(), minimumQuantity: z.number().positive(),
      available: z.boolean(), simpleSku: z.boolean(),
    }).parse(await call('account_retail_resolve_search', { ...args, itemId: input.itemId, keyword: input.query }));
    return { productRef: detail.productRef, report: deliveryItemReport.parse({
      ...base, name: detail.name, minimumQuantity: detail.minimumQuantity,
      variants: detail.simpleSku ? [{
        ref: 'default', name: detail.name, listedPriceMinor: detail.priceCents, stockQuantity: detail.stock, available: detail.available, groups: [],
      }] : [],
    }) };
  }
  const source = z.object({ platformId: z.literal('hema'), shopId: z.literal(merchantId), addressRef: z.literal(addressRef),
    categories: z.array(z.object({ items: z.array(z.object({ id: deliveryMerchantId, productRef: z.uuid() })) })).max(100),
  }).parse(await call('account_probe_menu', { ...args, keyword: input.query }));
  const matches = source.categories.flatMap(group => group.items).filter(item => item.id === input.itemId);
  if (matches.length !== 1) throw new Conflict('Refresh the Hema product search and select one current product');
  const productRef = matches[0]!.productRef;
  const detail = z.object({ shopId: z.literal(merchantId), productRef: z.literal(productRef), addressRef: z.literal(addressRef),
    platformId: z.literal('hema'), product: z.object({ id: z.literal(input.itemId), name: short.min(1), available: z.boolean(),
      price: nativeAmount, variants: z.array(detailStock).max(100),
    }),
  }).parse(await call('account_product_detail', { ...owner, addressRef, productRef })).product;
  return { productRef, variants: detail.variants, report: deliveryItemReport.parse({
    ...base, name: detail.name, minimumQuantity: detail.variants.length ? Math.min(...detail.variants.map(row => row.minimumQuantity)) : 1,
    variants: detail.variants.map(row => ({
      ref: row.id, name: row.name || detail.name, listedPriceMinor: detail.price == null ? null : yuanToFen(detail.price),
      stockQuantity: row.stockQuantity, available: detail.available && row.stockQuantity > 0, groups: [],
    })),
  }) };
}

export const sourceQuote = z.object({
  platformId: z.enum(['taobao', 'hema']), shopId: deliveryMerchantId, addressRef: revision, revision, quoteRef: z.uuid(),
  merchant: short, expiresAt: z.number().int().safe(), totalCents: cents.positive(), maxOrderCents: cents.positive(),
  deliveryTime: short.nullish(), discountCents: cents.optional(), couponCents: cents.optional(),
  items: z.array(sourceLine).min(1).max(500),
  fees: z.array(z.object({ name: short, amountCents: cents })).max(50),
  requiresDeliveryChoice: z.boolean().optional(),
  deliveryOptions: z.array(z.object({ ref: z.uuid(), label: short.min(1), feeCents: cents, selected: z.boolean() })).max(50).optional(),
});

export const sourceAttempt = z.object({
  orderRef: z.uuid(), amountCents: cents.positive(), orderIds: z.array(nativeOrderId).max(50),
  status: z.enum(['created', 'unknown']).optional(), paymentStatus: paymentState,
  officialOrders: z.array(z.object({ id: nativeOrderId, status: short.min(1), amount: nativeAmount, merchantName: short.min(1) })).max(50).optional(),
});
export const sourceOrder = sourceAttempt.omit({ status: true, officialOrders: true }).extend({
  platformId: z.enum(['taobao', 'hema']), orderIds: z.array(nativeOrderId).min(1).max(50),
});

export function historyFromSource(order: { id: string; status: string; merchantName: string; amount?: unknown }) {
  return deliveryHistoryEntry.parse({ id: order.id, status: order.status, merchant: order.merchantName,
    amountMinor: order.amount == null ? null : yuanToFen(order.amount) });
}
