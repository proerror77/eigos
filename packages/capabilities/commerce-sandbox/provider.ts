import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { commerceActionMetadata, parseCommerceEntity, type CommerceJourneyAction, type CommerceEntityType, type CommerceEntityData } from '../../ontology/commerce-journey.js';
import { SHIPPING_RULES, classifyShippingRoute, requiredShippingCodes } from '../../ontology/shipping-policy.js';
import { postalAddressDigest, sourcePayloadDigest } from '../../ontology/commerce-journey-functions.js';
import { sandboxPayloadSchema, sandboxRequestContextSchema, type CommerceSandboxOptions } from './connector.js';

type Context = z.infer<typeof sandboxRequestContextSchema>;
type Payload = z.infer<typeof sandboxPayloadSchema>;
export interface CommerceSandboxScenario {
  ambiguousAddress?: boolean; domesticAvailable?: boolean; unknownBuyerDuties?: boolean;
  importRestricted?: boolean; customsUnknown?: boolean; estimatedDeliveryOnly?: boolean;
  paymentState?: 'settled' | 'pending' | 'failed'; partialDelivery?: boolean; futureDelivery?: boolean;
  wrongApartment?: boolean; changedOrderCosts?: boolean; stockExpires?: boolean;
  addressApartment?: string; overseasLocalStock?: boolean; warehouseStatus?: 'free_circulation' | 'bonded' | 'customs_controlled' | 'unknown';
  missingReleaseEvidence?: boolean; transportUnknown?: boolean; routeEvidence?: 'missing_legs' | 'wrong_territory' | 'domestic_via_border';
  customsEvidence?: 'missing_clause' | 'duplicate_clause' | 'unregistered_rule' | 'stale_rule' | 'future_rule' | 'false_domestic';
}
interface Flags { dropNextResponse?: CommerceJourneyAction; dropBeforeDispatch?: CommerceJourneyAction; beforeResponse?: (action: CommerceJourneyAction) => Promise<void> }
const localOwner = digest(JSON.stringify(['local-development', 'local', 'developer']));
const id = z.string().min(1).max(200), quantity = z.number().int().min(1).max(1000), currency = z.enum(['CNY', 'USD']);
const inputSchemas = {
  ReadCommerceContext: z.strictObject({ contextKey: id }), SearchCommerceMerchants: z.strictObject({ query: z.string().min(1).max(300) }),
  ReadCommerceProduct: z.strictObject({ merchantId: id, query: z.string().min(1).max(300), currency: currency.optional() }),
  ReadCommerceInventory: z.strictObject({ merchantId: id, variantId: id, quantity, currency }),
  ReadCommerceFulfillment: z.strictObject({ merchantId: id, variantId: id, quantity, inventoryId: id, contextKey: id, addressId: id, addressRevision: id, destinationDigest: z.string().length(64), currency }),
  ReadCommerceCustoms: z.strictObject({ merchantId: id, variantId: id, fulfillmentId: id, optionId: id }),
  QuoteCommerceLandedCost: z.strictObject({ merchantId: id, variantId: id, inventoryId: id, fulfillmentId: id, optionId: id, customsId: id }),
  CreateCommerceCart: z.strictObject({ merchantId: id, variantId: id, quantity, currency }),
  ReadCommerceCart: z.strictObject({ cartId: id }),
  UpdateCommerceCart: z.strictObject({ cartId: id, expectedRevision: id, merchantId: id, variantId: id, quantity, currency }),
  CancelCommerceCart: z.strictObject({ cartId: id, expectedRevision: id }),
  PrepareCommerceCheckout: z.strictObject({ quoteId: id, sourceQuoteDigest: z.string().length(64), quoteDigest: z.string().length(64), cartId: id.optional() }),
  SubmitCommerceOrder: z.strictObject({ checkoutId: id, quoteDigest: z.string().length(64), expectedTotal: z.strictObject({ minor: z.string().regex(/^\d+$/), currency }), expectedDestinationDigest: z.string().length(64) }),
  ReadCommerceOrder: z.strictObject({ orderId: id, merchantId: id }), ReadCommercePayment: z.strictObject({ orderId: id, merchantId: id }), ReadCommerceDelivery: z.strictObject({ orderId: id, merchantId: id }),
};
class Rejected extends Error { constructor(readonly code: string, readonly status = 409) { super(code); } }
const reject = (code: string, status = 409): never => { throw new Rejected(code, status); };
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
const merchants = [
  { id: 'harbor-cn', name: '海港咖啡（沙箱）', registeredCountry: 'CN', categories: ['coffee', '咖啡'], supportedCurrencies: ['CNY', 'USD'] },
  { id: 'cedar-ca', name: '雪松咖啡（沙箱）', registeredCountry: 'CA', categories: ['coffee', '咖啡'], supportedCurrencies: ['CNY', 'USD'] },
];
const coffeeQuery = (query: string) => /coffee|咖啡|whole.?bean|整豆/i.test(query);
async function readBody(req: IncomingMessage) { const chunks: Buffer[] = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 65536) reject('REQUEST_TOO_LARGE', 413); chunks.push(Buffer.from(chunk)); } return JSON.parse(Buffer.concat(chunks).toString('utf8')); }

/** Independent, durable local business simulator. It has no outgoing network
 * clients, real merchant adapters or real payment credentials. */
export async function createCommerceSandboxProvider(options: { databasePath?: string; token?: string; port?: number; ownerDigests?: string[]; scenario?: CommerceSandboxScenario } = {}) {
  const path = options.databasePath ?? ':memory:'; if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path); db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS objects (owner TEXT NOT NULL,task TEXT NOT NULL,id TEXT NOT NULL,type TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,task,id));
    CREATE TABLE IF NOT EXISTS operations (owner TEXT NOT NULL,key TEXT NOT NULL,task TEXT NOT NULL,revision INTEGER NOT NULL,action TEXT NOT NULL,input_digest TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,key));
    CREATE TABLE IF NOT EXISTS audit (ordinal INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL);`);
  const setting = <T>(key: string, value: T): T => { const prior = db.prepare('SELECT body FROM settings WHERE key=?').get(key); if (prior) return JSON.parse(String(prior.body)) as T; db.prepare('INSERT INTO settings VALUES(?,?)').run(key, JSON.stringify(value)); return value; };
  const instanceId = setting('instanceId', randomUUID()), token = options.token ?? randomBytes(32).toString('hex');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Sandbox token must contain 32 random bytes');
  let scenario: CommerceSandboxScenario = { ambiguousAddress: true, unknownBuyerDuties: true, ...setting<CommerceSandboxScenario>('scenario', options.scenario ?? {}) };
  const allowedOwners = new Set(options.ownerDigests ?? [localOwner]), flags: Flags = {};
  const now = () => new Date().toISOString(), expiry = () => new Date(Date.now() + 30 * 60000).toISOString();
  const money = (minor: number | bigint | string, code: string) => ({ minor: String(minor), currency: code });
  const get = <T extends CommerceEntityType>(ctx: Context, key: string, type: T, fresh = true) => {
    const row = db.prepare('SELECT body FROM objects WHERE owner=? AND task=? AND id=?').get(ctx.ownerDigest, ctx.requestId, key); if (!row) return reject('SOURCE_OBJECT_NOT_FOUND', 404);
    const p = sandboxPayloadSchema.parse(JSON.parse(String(row.body))); if (p.type !== type) return reject('SOURCE_TYPE_MISMATCH'); if (fresh && Date.parse(p.expiresAt) <= Date.now()) return reject('SOURCE_EXPIRED');
    return { payload: p, data: parseCommerceEntity(type, p.data) };
  };
  const put = <T extends CommerceEntityType>(ctx: Context, type: T, sourceId: string, data: CommerceEntityData<T>, sourceVersion = 1, expiresAt = expiry()): Payload => {
    const checked = parseCommerceEntity(type, data), payload = sandboxPayloadSchema.parse({ type, sourceId, sourceVersion, data: checked, expiresAt });
    db.prepare('INSERT INTO objects VALUES(?,?,?,?,?) ON CONFLICT(owner,task,id) DO UPDATE SET body=excluded.body,type=excluded.type').run(ctx.ownerDigest, ctx.requestId, sourceId, type, JSON.stringify(payload)); return payload;
  };
  const product = (merchantId: string, variantId?: string, code = 'CNY') => {
    if (!merchants.some(m => m.id === merchantId) || variantId && variantId !== `${merchantId}-beans-340`) return reject('PRODUCT_NOT_FOUND', 404);
    return { merchantId, variantId: `${merchantId}-beans-340`, title: `${merchantId === 'harbor-cn' ? '海港' : '雪松'}中度烘焙整豆咖啡 340g（沙箱）`, sku: `${merchantId}-340`, unitPrice: money(code === 'CNY' ? merchantId === 'harbor-cn' ? 10500 : 12000 : merchantId === 'harbor-cn' ? 1500 : 1700, code), goodsOriginCountry: merchantId === 'harbor-cn' ? 'CN' : 'BR', hsCode: '090121', weightGrams: 340, category: 'roasted_coffee', availableReported: true, restrictions: [] };
  };
  const stockVersion = () => Number(setting('stockVersion', 1));
  const bumpStock = () => db.prepare("UPDATE settings SET body=? WHERE key='stockVersion'").run(JSON.stringify(stockVersion() + 1));
  const contextData = (key: string): CommerceEntityData<'FulfillmentContext'> => {
    if (key !== 'default' && key !== 'single-address' && key !== 'missing-address') return reject('CONTEXT_NOT_AVAILABLE', 404);
    const revision=String(setting('profileVersion',1));
    const addresses: CommerceEntityData<'FulfillmentContext'>['addresses'] = key === 'missing-address' ? [] : [
      { id: 'home', label: '家庭地址', address: { countryCode: 'CN', region: '北京市', city: '北京市', postalCode: '100000', street: '沙箱测试路 1 号', extendedAddress: scenario.addressApartment ?? '101 室', recipient: '沙箱收件人' }, revision, usable: true },
      ...(scenario.ambiguousAddress && key !== 'single-address' ? [{ id: 'office', label: '工作地址', address: { countryCode: 'GB', city: 'London', postalCode: 'SW1A 1AA', street: '1 Sandbox Test Lane', extendedAddress: 'Unit B', recipient: 'Sandbox Recipient' }, revision, usable: true }] : []),
    ];
    return { contextKey: key, profileRevision: revision, dataUse: 'this_sandbox_task', addresses, ...(addresses.length === 1 ? { preferredAddressId: addresses[0]!.id } : {}), available: true };
  };
  const dispatch = (ctx: Context, action: CommerceJourneyAction, raw: unknown): Payload => {
    const input = inputSchemas[action].parse(raw) as Record<string, any>;
    if (action === 'ReadCommerceContext') {const context=contextData(input.contextKey);return put(ctx, 'FulfillmentContext', `context:${input.contextKey}`, context,Number(context.profileRevision));}
    if (action === 'SearchCommerceMerchants') return put(ctx, 'CommerceMerchantSearch', `directory:${digest(input.query).slice(0,24)}`, { query: input.query, coverage: 'complete_sandbox_directory', merchants: coffeeQuery(input.query) ? merchants : [] });
    if (action === 'ReadCommerceProduct') { if (!coffeeQuery(input.query)) return reject('PRODUCT_NOT_FOUND', 404); const p = product(input.merchantId, undefined, input.currency); return put(ctx, 'CommerceProduct', `product:${p.merchantId}:${p.variantId}:${p.unitPrice.currency}`, p); }
    if (action === 'ReadCommerceInventory') {
      const p = product(input.merchantId, input.variantId, input.currency), domestic = p.merchantId === 'harbor-cn' || !!scenario.overseasLocalStock;
      const available = p.merchantId === 'harbor-cn' ? !!scenario.domesticAvailable : true;
      const locations: CommerceEntityData<'InventoryObservation'>['locations'] = domestic ? [{ warehouseId: 'cn-local', dispatchCountry: 'CN', availability: available ? 'confirmed' : 'unavailable', ...(available ? { confirmedQuantity: input.quantity, availableQuantity: 20 } : { confirmedQuantity: 0, availableQuantity: 0 }), quantityState: 'sellable' }] : [
        { warehouseId: 'us-east', dispatchCountry: 'US', availability: 'confirmed', confirmedQuantity: Math.min(1, input.quantity), availableQuantity: 1, quantityState: 'sellable' },
        { warehouseId: 'us-west', dispatchCountry: 'US', availability: 'confirmed', confirmedQuantity: Math.max(0, input.quantity - 1), quantityState: 'sellable' },
      ];
      for (const location of locations) location.regulation = { customsTerritory: SHIPPING_RULES.territories[location.dispatchCountry] ?? 'unknown', status: scenario.warehouseStatus ?? 'free_circulation', ...(!scenario.missingReleaseEvidence ? { releaseEvidence: `synthetic-stock-status:${location.warehouseId}:${p.variantId}` } : {}) };
      return put(ctx, 'InventoryObservation', `inventory:${p.variantId}`, { merchantId: p.merchantId, variantId: p.variantId, requestedQuantity: input.quantity, locations, reserved: false }, stockVersion(), scenario.stockExpires ? new Date(Date.now() + 50).toISOString() : expiry());
    }
    if (action === 'ReadCommerceFulfillment') {
      const p = product(input.merchantId, input.variantId, input.currency), inventory = get(ctx, input.inventoryId, 'InventoryObservation'), c = contextData(input.contextKey), address = c.addresses.find(a => a.id === input.addressId);
      if (!address || address.revision !== input.addressRevision || postalAddressDigest(address.address) !== input.destinationDigest || inventory.data.variantId !== p.variantId || inventory.data.requestedQuantity !== input.quantity || inventory.payload.sourceVersion !== stockVersion()) return reject('FULFILLMENT_INPUT_CHANGED');
      const locations = inventory.data.locations.filter(l => l.availability === 'confirmed' && (l.confirmedQuantity ?? 0) > 0); if (locations.reduce((n,l)=>n+(l.confirmedQuantity??0),0) < input.quantity) return reject('INSUFFICIENT_CAPACITY');
      const fulfillmentId = `fulfillment-${randomUUID()}`, groups = locations.map((l,i) => ({ id: `package-${i+1}`, variantId: p.variantId, quantity: l.confirmedQuantity!, warehouseId: l.warehouseId, dispatchCountry: l.dispatchCountry, destinationDigest: input.destinationDigest, carrier: 'Sandbox Carrier', service: 'Tracked sandbox shipping', transport: (l.dispatchCountry === address.address.countryCode ? 'road' : 'air') as 'road' | 'air', transitCountries: scenario.routeEvidence === 'domestic_via_border' ? ['HK'] : [], regulation: l.regulation, legs: scenario.routeEvidence === 'missing_legs' ? undefined : (scenario.routeEvidence === 'domestic_via_border' ? [{ fromCountry: l.dispatchCountry, toCountry: 'HK', fromTerritory: l.regulation!.customsTerritory, toTerritory: 'HK' }, { fromCountry: 'HK', toCountry: address.address.countryCode, fromTerritory: 'HK', toTerritory: SHIPPING_RULES.territories[address.address.countryCode] ?? 'unknown' }] : [{ fromCountry: l.dispatchCountry, toCountry: address.address.countryCode, fromTerritory: scenario.routeEvidence === 'wrong_territory' ? 'unreviewed' : l.regulation!.customsTerritory, toTerritory: SHIPPING_RULES.territories[address.address.countryCode] ?? 'unknown' }]) }));
      const domestic = groups.every(g=>g.dispatchCountry===address.address.countryCode && g.regulation?.status === 'free_circulation' && !g.transitCountries.length), price = (n:number) => money(input.currency === 'CNY' ? n : Math.ceil(n / 7), input.currency);
      const options: CommerceEntityData<'FulfillmentPlan'>['options'] = (domestic ? ['domestic'] : ['door-ddp','economy-dap']).map(optionId => ({ id: optionId, status: 'available', groups, promises: groups.map((g,i)=>({ id: `${fulfillmentId}:${optionId}:${g.id}`, issuer: p.merchantId, kind: scenario.estimatedDeliveryOnly ? 'estimate' : 'commitment', milestone: 'arrival', earliestAt: new Date(Date.now()+(domestic?1:2+i)*86400000).toISOString(), latestAt: new Date(Date.now()+(domestic?2:3+i)*86400000).toISOString(), timeZone: 'UTC', groupIds:[g.id], destinationDigest: input.destinationDigest, conditions:[{code:'import_eligibility',status:domestic?'met':'unknown',description:'Applicable import conditions must be established before purchase'}],expiresAt:expiry(),exceptions:['Synthetic test scenario only'],remedy:'Sandbox delay refund obligation'})), shippingPrice: price(domestic?1000:optionId==='door-ddp'?3000:1000), incoterm: domestic?'domestic':optionId==='door-ddp'?'DDP':'DAP', namedPlace: `${address.address.countryCode} ${address.label}` }));
      return put(ctx,'FulfillmentPlan',fulfillmentId,{merchantId:p.merchantId,variantId:p.variantId,quantity:input.quantity,contextKey:c.contextKey,addressId:address.id,addressRevision:address.revision,destination:address.address,destinationCustomsTerritory:SHIPPING_RULES.territories[address.address.countryCode] ?? 'unknown',destinationDigest:input.destinationDigest,options});
    }
    if (action === 'ReadCommerceCustoms') {
      const f=get(ctx,input.fulfillmentId,'FulfillmentPlan'), option=f.data.options.find(o=>o.id===input.optionId), p=product(input.merchantId,input.variantId);
      if(!option||f.data.variantId!==p.variantId||f.data.merchantId!==p.merchantId) return reject('CUSTOMS_ROUTE_MISMATCH');
      const stock = get(ctx, `inventory:${p.variantId}`, 'InventoryObservation');
      const route = classifyShippingRoute(f.data, option.id, stock.data), domestic = route.customsRequired === false, code = option.shippingPrice.currency, ddp = option.incoterm === 'DDP';
      const clauses = requiredShippingCodes(route).map(code => ({ code, status: code === 'commodity_import_check' ? scenario.importRestricted ? 'unmet' as const : scenario.customsUnknown ? 'unknown' as const : 'met' as const : scenario.transportUnknown ? 'unknown' as const : 'met' as const, description: 'Synthetic route-specific source requirement' }));
      const requirements = scenario.customsEvidence === 'missing_clause' ? [] : scenario.customsEvidence === 'duplicate_clause' ? [...clauses, clauses[0]!] : clauses;
      const applicabilityOffset=scenario.customsEvidence==='stale_rule'?-31*60000:scenario.customsEvidence==='future_rule'?60000:0;
      return put(ctx,'CustomsAssessment',`customs-${randomUUID()}`,{merchantId:p.merchantId,variantId:p.variantId,quantity:f.data.quantity,fulfillmentId:f.payload.sourceId,optionId:option.id,destinationDigest:f.data.destinationDigest,dispatchCountries:[...new Set(option.groups.map(g=>g.dispatchCountry))],destinationCountry:f.data.destination.countryCode,goodsOriginCountry:p.goodsOriginCountry,hsCode:p.hsCode,shippingRegime:route.regime,routeDigest:route.routeDigest,status:route.status==='unknown'?'unknown':scenario.customsEvidence==='false_domestic'?'not_applicable':domestic?'not_applicable':scenario.importRestricted?'restricted':scenario.customsUnknown?'unknown':'allowed',requirements,importer:domestic?'buyer':ddp?'seller':'buyer',dutyPayer:ddp?'seller':'buyer',...(!scenario.unknownBuyerDuties||domestic?{duty:money(domestic?0:code==='CNY'?1500:215,code),tax:money(domestic?0:code==='CNY'?800:115,code),clearanceFee:money(domestic?0:code==='CNY'?200:29,code)}:{}),sourceRuleVersion:scenario.customsEvidence==='unregistered_rule'?'unregistered-customs-rule-v99':`synthetic-${domestic ? `${route.regime}-` : ''}${f.data.destination.countryCode}-${p.hsCode}-v1`,applicableAt:new Date(Date.now()+applicabilityOffset).toISOString(),syntheticRules:true});
    }
    if(action==='QuoteCommerceLandedCost'){
      const f=get(ctx,input.fulfillmentId,'FulfillmentPlan'),inv=get(ctx,input.inventoryId,'InventoryObservation'), customs=get(ctx,input.customsId,'CustomsAssessment'),option=f.data.options.find(o=>o.id===input.optionId),p=product(input.merchantId,input.variantId,f.data.options[0]!.shippingPrice.currency);
      if(!option||customs.data.fulfillmentId!==f.payload.sourceId||customs.data.optionId!==option.id||customs.data.variantId!==p.variantId||inv.data.variantId!==p.variantId||inv.data.requestedQuantity!==f.data.quantity||inv.payload.sourceVersion!==stockVersion())return reject('QUOTE_INPUT_CHANGED');
      if(!['allowed','not_applicable'].includes(customs.data.status)||customs.data.requirements.some(r=>r.status!=='met'))return reject('IMPORT_REQUIREMENTS_UNRESOLVED');
      const code=p.unitPrice.currency,ddp=option.incoterm==='DDP',components:CommerceEntityData<'LandedCostQuote'>['components']=[{id:'goods',category:'goods',amount:money(BigInt(p.unitPrice.minor)*BigInt(f.data.quantity),code),amountStatus:'fixed',payer:'buyer',timing:'checkout',coveredByTotal:true},{id:'shipping',category:'shipping',amount:option.shippingPrice,amountStatus:'fixed',payer:'buyer',timing:'checkout',coveredByTotal:true}];
      for(const [category,value]of [['duty',customs.data.duty],['tax',customs.data.tax],['clearance',customs.data.clearanceFee]] as const)components.push({id:category,category,...(value?{amount:value}:{}),amountStatus:value?'fixed':'unknown',payer:ddp?'seller':'buyer',timing:ddp?'included':value?'checkout':'arrival',coveredByTotal:ddp||!!value,...(ddp?{responsibilityEvidence:`${p.merchantId}:DDP-all-inclusive-v1`}:{})});
      const total=components.filter(c=>c.payer==='buyer'&&c.coveredByTotal&&c.amount).reduce((n,c)=>n+BigInt(c.amount!.minor),0n), complete=components.every(c=>c.payer==='seller'&&!!c.responsibilityEvidence||c.payer==='buyer'&&c.coveredByTotal&&c.amountStatus==='fixed');
      return put(ctx,'LandedCostQuote',`quote-${randomUUID()}`,{merchantId:p.merchantId,variantId:p.variantId,quantity:f.data.quantity,unitPrice:p.unitPrice,inventoryId:inv.payload.sourceId,inventoryVersion:inv.payload.sourceVersion,fulfillmentId:f.payload.sourceId,optionId:option.id,customsId:customs.payload.sourceId,destinationDigest:f.data.destinationDigest,components,buyerTotal:money(total,code),scope:complete?'all_buyer_mandatory_fees':'partial',priceKind:'firm',incoterm:option.incoterm,termsVersion:`${p.merchantId}-${option.incoterm}-v1`,groups:option.groups,promises:option.promises.map(p=>({...p,conditions:p.conditions.map(c=>({...c,status:'met' as const}))}))});
    }
    if(action==='CreateCommerceCart'||action==='UpdateCommerceCart'){
      const p=product(input.merchantId,input.variantId,input.currency), existing=action==='UpdateCommerceCart'?get(ctx,input.cartId,'Cart'):undefined;
      if(existing&&(existing.data.state!=='active'||existing.data.revision!==input.expectedRevision||existing.data.merchantId!==p.merchantId))return reject('CART_VERSION_CHANGED');
      const cartId=existing?.data.cartId??`cart-${randomUUID()}`,version=(existing?.payload.sourceVersion??0)+1;
      return put(ctx,'Cart',cartId,{cartId,merchantId:p.merchantId,revision:String(version),state:'active',lines:[{merchantId:p.merchantId,variantId:p.variantId,title:p.title,quantity:input.quantity,unitPrice:p.unitPrice}],inventoryReserved:false,estimatedTotal:money(BigInt(p.unitPrice.minor)*BigInt(input.quantity),p.unitPrice.currency)},version);
    }
    if(action==='CancelCommerceCart'){
      const c=get(ctx,input.cartId,'Cart');if(c.data.state!=='active'||c.data.revision!==input.expectedRevision)return reject('CART_VERSION_CHANGED');
      return put(ctx,'Cart',c.payload.sourceId,{...c.data,state:'canceled',revision:String(c.payload.sourceVersion+1)},c.payload.sourceVersion+1);
    }
    if(action==='ReadCommerceCart'){const c=get(ctx,input.cartId,'Cart',false);return put(ctx,'Cart',c.payload.sourceId,c.data,c.payload.sourceVersion);}
    if(action==='PrepareCommerceCheckout'){
      const q=get(ctx,input.quoteId,'LandedCostQuote');if(sourcePayloadDigest(q.payload)!==input.sourceQuoteDigest||q.data.scope!=='all_buyer_mandatory_fees'||q.data.priceKind!=='firm')return reject('QUOTE_CHANGED');
      if(input.cartId){const c=get(ctx,input.cartId,'Cart');if(c.data.state!=='active'||c.data.merchantId!==q.data.merchantId||c.data.lines.length!==1||c.data.lines[0]!.variantId!==q.data.variantId||c.data.lines[0]!.quantity!==q.data.quantity)return reject('CART_QUOTE_MISMATCH');}
      const checkoutId=`checkout-${randomUUID()}`,p=product(q.data.merchantId,q.data.variantId,q.data.unitPrice.currency);
      return put(ctx,'CommerceCheckout',checkoutId,{checkoutId,merchantId:q.data.merchantId,...(input.cartId?{cartId:input.cartId}:{}),quoteId:q.payload.sourceId,quoteDigest:input.quoteDigest,destinationDigest:q.data.destinationDigest,lines:[{merchantId:p.merchantId,variantId:p.variantId,title:p.title,quantity:q.data.quantity,unitPrice:q.data.unitPrice}],total:q.data.buyerTotal,costComponents:q.data.components,state:'ready',expiresAt:q.payload.expiresAt});
    }
    if(action==='SubmitCommerceOrder'){
      const c=get(ctx,input.checkoutId,'CommerceCheckout');if(c.data.state!=='ready'||c.data.quoteDigest!==input.quoteDigest||!same(c.data.total,input.expectedTotal)||c.data.destinationDigest!==input.expectedDestinationDigest)return reject('CHECKOUT_CHANGED');
      const quote=get(ctx,c.data.quoteId,'LandedCostQuote');if(quote.data.inventoryVersion!==stockVersion())return reject('STOCK_CHANGED');
      const route=get(ctx,quote.data.fulfillmentId,'FulfillmentPlan'),context=contextData(route.data.contextKey),address=context.addresses.find(a=>a.id===route.data.addressId);
      if(!address||address.revision!==route.data.addressRevision||postalAddressDigest(address.address)!==quote.data.destinationDigest)return reject('DESTINATION_CHANGED');
      const orderId=`order-${randomUUID()}`,order:CommerceEntityData<'CommerceOrderObservation'>={orderId,merchantId:c.data.merchantId,checkoutId:c.data.checkoutId,quoteId:c.data.quoteId,quoteDigest:c.data.quoteDigest,destinationDigest:c.data.destinationDigest,lines:c.data.lines,total:c.data.total,costComponents:c.data.costComponents,state:'confirmed',fulfillment:'pending',independentRead:false};
      put(ctx,'CommerceCheckout',c.payload.sourceId,{...c.data,state:'completed',orderId},c.payload.sourceVersion+1);bumpStock();
      return put(ctx,'CommerceOrderObservation',orderId,order);
    }
    if(action==='ReadCommerceOrder'){
      const o=get(ctx,input.orderId,'CommerceOrderObservation',false);if(o.data.merchantId!==input.merchantId)return reject('ORDER_OWNER_MISMATCH');
      return put(ctx,'CommerceOrderObservation',o.payload.sourceId,{...o.data,independentRead:true,...(scenario.wrongApartment?{destinationDigest:digest({wrong:'Unit B'})}:{}),...(scenario.changedOrderCosts?{costComponents:o.data.costComponents.map((c,i)=>i===0?{...c,category:'duty' as const}:c)}:{})},o.payload.sourceVersion);
    }
    if(action==='ReadCommercePayment'){
      const o=get(ctx,input.orderId,'CommerceOrderObservation',false);if(o.data.merchantId!==input.merchantId)return reject('ORDER_OWNER_MISMATCH');
      const paymentId=`payment:${o.data.orderId}`,prior=db.prepare('SELECT body FROM objects WHERE owner=? AND task=? AND id=?').get(ctx.ownerDigest,ctx.requestId,paymentId),old=prior?sandboxPayloadSchema.parse(JSON.parse(String(prior.body))):undefined;
      const state=scenario.paymentState??'settled',sameState=old?.data.state===state;
      return put(ctx,'CommercePaymentObservation',paymentId,{paymentId,orderId:o.data.orderId,merchantId:o.data.merchantId,amount:o.data.total,state,receiptId:`receipt:${paymentId}`,observedAt:sameState?String(old!.data.observedAt):now()},old?(sameState?old.sourceVersion:old.sourceVersion+1):1);
    }
    const o=get(ctx,input.orderId,'CommerceOrderObservation',false),q=get(ctx,o.data.quoteId,'LandedCostQuote',false);if(o.data.merchantId!==input.merchantId)return reject('ORDER_OWNER_MISMATCH');
    const deliveryId=`delivery:${o.data.orderId}`,prior=db.prepare('SELECT body FROM objects WHERE owner=? AND task=? AND id=?').get(ctx.ownerDigest,ctx.requestId,deliveryId),old=prior?sandboxPayloadSchema.parse(JSON.parse(String(prior.body))):undefined;
    const groups=scenario.partialDelivery?q.data.groups.slice(0,1):q.data.groups,oldEvents=old?parseCommerceEntity('CommerceDeliveryObservation',old.data).events:[],events=groups.map(g=>({id:`delivered:${o.data.orderId}:${g.id}`,groupId:g.id,variantId:g.variantId,quantity:g.quantity,occurredAt:oldEvents.find(e=>e.groupId===g.id)?.occurredAt??new Date(Date.now()+(scenario.futureDelivery?86400000:-1)).toISOString(),milestone:'delivered' as const,destinationDigest:o.data.destinationDigest}));
    const data:CommerceEntityData<'CommerceDeliveryObservation'>={orderId:o.data.orderId,merchantId:o.data.merchantId,destinationDigest:o.data.destinationDigest,state:scenario.partialDelivery?'partial':'delivered',events};
    return put(ctx,'CommerceDeliveryObservation',deliveryId,data,old?(same(old.data,data)?old.sourceVersion:old.sourceVersion+1):1);
  };
  const server=createServer(async(req,res)=>{
    const pathname=new URL(req.url!,'http://127.0.0.1').pathname;
    if(req.method==='GET'&&pathname==='/health'){res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',environment:'sandbox',instanceId,protocol:'eigos.commerce.sandbox.v1',realOperationsAllowed:false}));return;}
    let ctx:Context|undefined, applied=false;
    const send=(value:unknown,status=200)=>{const raw=Buffer.from(JSON.stringify(value));res.statusCode=status;res.setHeader('content-type','application/json');res.setHeader('x-eigos-sandbox-signature',createHmac('sha256',token).update(raw).digest('hex'));res.end(raw);};
    try{
      if(req.headers.authorization!==`Bearer ${token}`)return send({error:'unauthorized'},401);
      ctx=sandboxRequestContextSchema.parse(JSON.parse(Buffer.from(String(req.headers['x-eigos-context']??''),'base64url').toString('utf8')));
      if(!allowedOwners.has(ctx.ownerDigest))return reject('OWNER_NOT_ALLOWED',403);
      let result:Payload,action:CommerceJourneyAction,source:typeof commerceActionMetadata[CommerceJourneyAction]['source'];
      if(req.method==='GET'&&pathname.startsWith('/operations/')){
        const key=decodeURIComponent(pathname.slice('/operations/'.length));if(key!==ctx.operationKey)return reject('OPERATION_KEY_MISMATCH');
        const original=db.prepare('SELECT * FROM operations WHERE owner=? AND key=?').get(ctx.ownerDigest,key);
        if(!original)return reject('OPERATION_NOT_FOUND',404);
        if(original.task!==ctx.requestId||Number(original.revision)!==ctx.requestRevision||original.action!==ctx.action)return reject('OPERATION_OWNER_MISMATCH',403);
        result=sandboxPayloadSchema.parse(JSON.parse(String(original.body))); result={...result,expiresAt:expiry()}; action=ctx.action as CommerceJourneyAction;source=commerceActionMetadata[action].source;
      }else{
        if(req.method!=='POST'||!pathname.startsWith('/actions/'))return reject('UNKNOWN_ENDPOINT',404);
        action=pathname.slice('/actions/'.length) as CommerceJourneyAction;if(!Object.hasOwn(inputSchemas,action)||ctx.action!==action)return reject('UNKNOWN_ACTION',404);
        const body=z.strictObject({context:sandboxRequestContextSchema,payload:z.record(z.string(),z.unknown())}).parse(await readBody(req));if(!same(body.context,ctx))return reject('CONTEXT_MISMATCH',403);
        if(flags.dropBeforeDispatch===action){delete flags.dropBeforeDispatch;db.prepare('INSERT INTO audit(body) VALUES(?)').run(JSON.stringify({at:now(),method:req.method,path:pathname,...ctx,transportDroppedBeforeDispatch:true,applied:false,realOperationsAllowed:false}));req.socket.destroy();return;}
        const fingerprint=digest({action,payload:body.payload,requestId:ctx.requestId,requestRevision:ctx.requestRevision}),prior=db.prepare('SELECT * FROM operations WHERE owner=? AND key=?').get(ctx.ownerDigest,ctx.operationKey);
        if(prior){if(prior.input_digest!==fingerprint)return reject('IDEMPOTENCY_INPUT_CHANGED');result=sandboxPayloadSchema.parse(JSON.parse(String(prior.body)));}
        else{db.exec('BEGIN IMMEDIATE');try{result=dispatch(ctx,action,body.payload);db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?)').run(ctx.ownerDigest,ctx.operationKey,ctx.requestId,ctx.requestRevision,action,fingerprint,JSON.stringify(result));db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}}
        source=commerceActionMetadata[action].source; applied=commerceActionMetadata[action].effect!=='read';
      }
      db.prepare('INSERT INTO audit(body) VALUES(?)').run(JSON.stringify({at:now(),method:req.method,path:pathname,...ctx,source,resultType:result.type,sourceId:result.sourceId,responsePayloadDigest:sourcePayloadDigest(result),effect:pathname.startsWith('/operations/')?'read':commerceActionMetadata[action].effect,realOperationsAllowed:false}));
      if(flags.dropNextResponse===action&&req.method==='POST'){delete flags.dropNextResponse;req.socket.destroy();return;}
      await flags.beforeResponse?.(action);
      send({environment:'sandbox',sourceIdentity:`commerce-sandbox:${instanceId}:${source}`,source,context:ctx,operationId:ctx.operationKey,operationVersion:result.sourceVersion,result});
    }catch(error){if(ctx){const code=error instanceof Rejected?error.code:error instanceof z.ZodError?'INVALID_INPUT':'INTERNAL_ERROR';db.prepare('INSERT INTO audit(body) VALUES(?)').run(JSON.stringify({at:now(),method:req.method,path:pathname,...ctx,error:code,applied,realOperationsAllowed:false}));send({environment:'sandbox',context:ctx,error:{code,applied}},error instanceof Rejected?error.status:error instanceof z.ZodError?400:500);}else send({error:'invalid_context'},400);}
  });
  server.listen(options.port??0,'127.0.0.1');await once(server,'listening');
  const endpoint=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  return { endpoint,token,instanceId,flags,
    setScenario(next:CommerceSandboxScenario){if(next.addressApartment!==undefined&&next.addressApartment!==scenario.addressApartment||next.ambiguousAddress!==undefined&&next.ambiguousAddress!==scenario.ambiguousAddress){const version=Number(setting('profileVersion',1));db.prepare("UPDATE settings SET body=? WHERE key='profileVersion'").run(JSON.stringify(version+1));}scenario={...scenario,...next};db.prepare("UPDATE settings SET body=? WHERE key='scenario'").run(JSON.stringify(scenario));},
    audit:()=>db.prepare('SELECT body FROM audit ORDER BY ordinal').all().map(r=>JSON.parse(String(r.body)) as Record<string,unknown>),
    counts:()=>Object.fromEntries((db.prepare('SELECT action,count(*) AS n FROM operations GROUP BY action').all()).map(r=>[String(r.action),Number(r.n)])),
    advanceStockVersion:()=>bumpStock(),
    close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();},
  };
}
