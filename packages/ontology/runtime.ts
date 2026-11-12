import { createHash } from 'node:crypto';
import type { DatasourceMapping } from './datasource-mapping.js';
import { resolveProperties } from './datasource-mapping.js';

/**
 * The runtime seam between a service and the ontology.
 *
 * Palantir's runtime is: a datasource supplies instances, object storage holds them, object sets are
 * queried by type or interface, and relationships are traversed from an object. All of those pieces
 * exist here -- ingest, query, link traversal -- but nothing connected a real provider to them. This
 * is that connection, and it deliberately knows no service: it takes a mapping and payloads.
 */

export interface ProviderReceipt {
  /** Identity of the thing that was read, e.g. 'didi:maps_textsearch'. */
  readonly source: string;
  readonly observedAt: string;
}

export interface SyncInput {
  readonly owner: string;
  readonly mapping: DatasourceMapping;
  readonly payloads: readonly Record<string, unknown>[];
  readonly receipt: ProviderReceipt;
  /** The relationship that cites a receipt from the object, e.g. PlaceEvidence. */
  readonly evidenceLink: string;
  readonly receiptType?: string;
}

export interface SyncResult {
  readonly objects: number;
  readonly links: number;
  /** Payloads that could not be represented, with the reason. Never silently dropped. */
  readonly rejected: { readonly index: number; readonly reason: string }[];
}

const receiptTypeDefault = 'SourceReceipt';

/** Turn provider payloads into stored objects, each citing the receipt that justifies it. */
export function syncProvider(store: any, input: SyncInput): SyncResult {
  const objects: any[] = [];
  const links: any[] = [];
  const rejected: { index: number; reason: string }[] = [];
  const receiptType = input.receiptType ?? receiptTypeDefault;
  const receiptId = `receipt:${input.receipt.source}:${input.receipt.observedAt}`;

  input.payloads.forEach((payload, index) => {
    try {
      const { properties, derived } = resolveProperties(input.mapping, payload);
      // Identity is not sent by the provider; it is derived, and that is stated in the mapping.
      // The mapping says the identity is derived rather than sent, so the adapter computes it here;
      // the reason string in `derived` explains why, it is not the value.
      const id = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      const identityProperty = Object.keys(derived)[0] ?? 'id';
      objects.push({ ref: { type: input.mapping.objectType, id }, properties: { ...properties, [identityProperty]: id } });
      links.push({
        type: input.evidenceLink,
        from: { type: input.mapping.objectType, id },
        to: { type: receiptType, id: receiptId },
        properties: { observedAt: input.receipt.observedAt, sourceRevision: '1', evidenceLevel: 'primary' },
      });
    } catch (error: any) {
      rejected.push({ index, reason: String(error?.message ?? error) });
    }
  });

  if (!objects.length) return { objects: 0, links: 0, rejected };

  objects.push({
    ref: { type: receiptType, id: receiptId },
    properties: {
      receiptId,
      displayTitle: input.receipt.source,
      safeSummary: `${objects.length} object(s) read from ${input.receipt.source}`,
      sourceIdentity: input.receipt.source,
      observedAt: input.receipt.observedAt,
    },
  });

  store.ingest(input.owner, { objects, links }, { kind: 'provider', id: input.receipt.source, observedAt: input.receipt.observedAt });
  return { objects: objects.length - 1, links: links.length, rejected };
}

/**
 * Object sets, as Palantir exposes them: everything of a type, or everything implementing an
 * interface. An interface query reaches the concrete object types that declare it.
 */
export function queryByInterface(store: any, model: any, owner: string, interfaceId: string): { types: string[]; rows: { type: string; id: string }[] } {
  const implementers: string[] = (model.interfaces ?? [])
    .flatMap((type: any) => model.describeType(type.id)?.interfaces ?? [])
    .filter((entry: any) => String(entry.id) === interfaceId)
    .map((entry: any) => String(entry.objectType ?? entry.implementer ?? ''))
    .filter(Boolean);

  const types = implementers.length ? [...new Set(implementers)] : concretesFor(model, interfaceId);
  const rows: { type: string; id: string }[] = [];
  for (const type of types) {
    const result: any = store.query(owner, { type });
    const found: any[] = result?.objects ?? result?.rows ?? [];
    for (const row of found) rows.push({ type, id: String(row.ref?.id ?? row.id) });
  }
  return { types, rows };
}

const concretesFor = (model: any, interfaceId: string): string[] => {
  const names: string[] = [];
  for (const type of model.types ?? []) {
    const described = model.describeType(type.id);
    if ((described?.interfaces ?? []).some((entry: any) => String(entry.id) === interfaceId)) names.push(String(type.id));
  }
  return names;
};

/** Traverse one relationship from an object; the receipt side of an evidence edge. */
export function traverse(store: any, owner: string, from: { type: string; id: string }, link: string): any[] {
  const result: any = store.query(owner, { from, link });
  return result?.objects ?? result?.rows ?? [];
}
