import type { z } from 'zod';
import { marketplaceFacts, marketplaceProvider, marketplacePriceGroup } from '../../ontology/service-contracts.js';
import type { ObjectRef } from '../../ontology/schema.js';

type PriceGroup = z.infer<typeof marketplacePriceGroup>;
type VendorItem = { ref: ObjectRef; properties: Record<string, unknown> };

// Alliance listings can include several variants. Use the whole advertised title,
// and require an explicit model and spec before placing offers in a price group.
function advertisedModelAndSpec(title: string) {
  const normalized = title.normalize('NFC').trim().replace(/\s+/g, ' ').toUpperCase();
  if (/[\/／|｜~～、]|任选|随机|多色|多款|多规格|可选|起售|起步|若干|链接|套餐可选|颜色自选/.test(normalized)) return;
  const specs = /(?:(?<![A-Z0-9.])\d+(?:\.\d+)?\s*(TB|GB|MB|ML|KG|CM|MM|MAH|G|L|W|片|支|包|盒|瓶|件|个|套|寸)(?![A-Z0-9])|(?:黑|白|银|灰|蓝|绿|粉|红|紫|金)色)/g;
  const attributes = [...normalized.matchAll(specs)].map(match => match[1] ?? 'color');
  if (!attributes.length || new Set(attributes).size !== attributes.length) return;
  const name = normalized.replace(specs, ' ');
  const models = name.match(/(?:型号\s*[:：]\s*[A-Z0-9][A-Z0-9-]{2,}|\b(?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*\d)[A-Z0-9]+(?:-[A-Z0-9]+)*\b)/g);
  if (models?.length !== 1) return;
  return normalized;
}

export function compareMarketplacePrices(items: VendorItem[]) {
  const candidates = new Map<string, PriceGroup>();
  const matched = new Set<ObjectRef>();
  for (const item of items) {
    const facts = marketplaceFacts.safeParse(item.properties);
    const provider = marketplaceProvider.safeParse(item.properties.provider);
    if (!facts.success || !provider.success || facts.data.currency !== 'CNY' || facts.data.amountMinor === null) continue;
    const title = advertisedModelAndSpec(facts.data.name);
    if (!title) continue;
    let group = candidates.get(title);
    if (!group) {
      group = { title: facts.data.name, matchBasis: 'same_advertised_model_and_specification',
        currency: 'CNY', priceKind: 'reference', offers: [] };
      candidates.set(title, group);
    }
    group.offers.push({ provider: provider.data, offer: item.ref, amountMinor: facts.data.amountMinor });
  }
  const groups = [...candidates.values()].filter(group => new Set(group.offers.map(offer => offer.provider)).size === 2);
  for (const group of groups) {
    group.offers.sort((a, b) => a.amountMinor - b.amountMinor);
    for (const offer of group.offers) matched.add(offer.offer);
  }
  return { groups, unmatched: items.filter(item => !matched.has(item.ref)).map(item => item.ref) };
}
