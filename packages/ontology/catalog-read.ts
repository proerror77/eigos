import { z } from 'zod';
import { catalogSnapshotSchema } from '../capabilities/shopify/contracts.js';
import type { ObjectTypeDefinition, LinkDefinition, PropertyDefinition, FunctionDefinition } from './model.js';

const p = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string): PropertyDefinition => ({ kind, schema, description, required: true, source: 'Validated anonymous catalog query, canonical merchant identity and source HTTP receipts' });
export const catalogReadObjects: ObjectTypeDefinition[] = [{
  id: 'CatalogRead', version: '1', name: '公开商品查询记录', aliases: ['CatalogRead', '商品查询', 'Shopify'], description: 'A bounded public catalog observation, distinct from merchant approval, purchase authority, stock reservation or delivery',
  primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'EvidenceBacked' }],
  properties: { id: p('string', z.string().min(1).max(200), 'Query observation identity'), displayTitle: p('string', z.string().min(1).max(500), 'Query label'),
    requestRevision: p('integer', z.number().int().positive(), 'Fixed request revision'), query: p('struct', catalogSnapshotSchema.shape.query, 'Exact query scope and market, not a delivery destination'),
    phase: p('string', catalogSnapshotSchema.shape.phase, 'prepared source read or independently verified final read'),
    snapshot: p('struct', catalogSnapshotSchema, 'Source-bound public facts and explicit unknowns; prices are display prices, never all-fee checkout totals'),
  },
}];
export const catalogReadLinks: LinkDefinition[] = [
  { id: 'CatalogReadRequest', description: 'Query observation belongs to its request', from: { type: 'CatalogRead', name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: 'catalogReads', many: true } },
  { id: 'CatalogReadOffers', description: 'Display-price observations returned by this query', from: { type: 'CatalogRead', name: 'offers', many: true }, to: { type: 'ProductOffer', name: 'catalogRead', many: false } },
  { id: 'CatalogReadEvidence', description: 'Catalog observation source proof', from: { type: 'CatalogRead', name: 'sourceReceipts', many: true, required: true }, to: { type: 'SourceReceipt', name: 'catalogReads', many: true } },
];
export const catalogReadFunctions: FunctionDefinition[] = [{ id: 'catalogReadStatus', version: '1', inputTypes: ['CatalogRead'], description: 'Check query identity, freshness and bound source evidence; return display-price observations and unknowns without granting business authority' }];
