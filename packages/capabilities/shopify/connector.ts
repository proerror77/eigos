import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ShopifyReadOnlyClient, type ShopifyReadReceipt } from './read-only.js';

export interface CatalogCallContext {
  requestId: string; requestRevision: number; configurationDigest: string;
  action: string; actionInputDigest: string; planId: string; intentId: string; attemptId: string; modelRunId: string;
}
export interface CatalogCall {
  operation: 'discovery' | 'search_catalog' | 'get_product' | 'lookup_catalog';
  input?: Record<string, unknown>; merchantDomain?: string; discoveredProfile?: unknown;
}
export interface CatalogCallResult { value: unknown; receipt: ShopifyReadReceipt }
export interface CatalogConnector {
  readonly evidenceKind: 'live_readonly' | 'fixture';
  invoke(context: CatalogCallContext, call: CatalogCall, signal: AbortSignal): Promise<CatalogCallResult>;
}

/** One invocation, one vendor HTTP operation. This connector does not search for
 * candidates, select a variant, discover implicitly, refresh, plan or complete. */
export class AnonymousShopifyConnector implements CatalogConnector {
  readonly evidenceKind: 'live_readonly' | 'fixture';
  constructor(private auditDirectory?: string, private fetcher?: typeof fetch) { this.evidenceKind = fetcher ? 'fixture' : 'live_readonly'; }
  async invoke(context: CatalogCallContext, call: CatalogCall, signal: AbortSignal): Promise<CatalogCallResult> {
    const client = new ShopifyReadOnlyClient({ merchantDomain: call.merchantDomain, onEvidence: async (receipt, raw) => {
      if (!this.auditDirectory) return;
      await mkdir(join(this.auditDirectory, 'responses'), { recursive: true, mode: 0o700 });
      await writeFile(join(this.auditDirectory, 'responses', `${receipt.id}.json`), raw, { mode: 0o600 });
      await appendFile(join(this.auditDirectory, 'reads.jsonl'), JSON.stringify({ ...context, transportInput: call.input ?? null, receipt }) + '\n', { mode: 0o600 });
    } }, this.fetcher);
    if (call.operation === 'discovery') return client.discover(signal);
    if (call.merchantDomain) client.restoreDiscovery(call.discoveredProfile);
    return client.read(call.operation, call.input, signal);
  }
}
