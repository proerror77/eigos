import { request } from 'node:http';
import { z } from 'zod';
import { digest, NotFound, PermissionDenied, SourceReadFailure } from '../../core/identity.js';
import type { RuntimeExtensions } from '../../runtime/extensions.js';
import { ingest } from '../../runtime/ingestion.js';
import { normalizedQuote, partnerQuote, quoteDefinition, quoteId, quoteInput, quoteObservation,
  quoteReceiptLink, quoteSourceGrant, quoteSourceName } from '../../ontology/spared-quote.js';

export const appName = (artifact: string, owner: string) => 'quote-' + artifact.slice(0, 16) + '-' + digest(owner).slice(0, 16);
const configSchema = z.strictObject({
  port: z.number().int().min(1).max(65535),
  wasmSha256: z.string().regex(/^[a-f0-9]{64}$/),
  owners: z.array(z.strictObject({
    owner: z.string().min(1).max(200),
    quotes: z.record(quoteId, z.strictObject({ quote: partnerQuote, observedAt: z.iso.datetime() })),
  })).min(1),
});

export async function normalizeSparedQuote(port: number, app: string, input: z.infer<typeof partnerQuote>, signal: AbortSignal) {
  const payload = JSON.stringify(input);
  return new Promise<z.infer<typeof normalizedQuote>>((resolve, reject) => {
    const outgoing = request({
      hostname: '127.0.0.1', port, method: 'POST', path: '/normalize',
      headers: { Host: app + '.localhost', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
    }, async response => {
      try {
        if (response.statusCode !== 200) throw new Error('spared rejected the normalization request');
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of response) {
          bytes += chunk.length;
          if (bytes > 2048) throw new Error('spared exceeded its response limit');
          chunks.push(chunk);
        }
        resolve(normalizedQuote.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    outgoing.on('error', reject);
    outgoing.end(payload);
  });
}

export function sparedQuotePilot(rawConfig: unknown): RuntimeExtensions {
  const { port, wasmSha256, owners } = configSchema.parse(rawConfig);
  const implementationId = 'spared-quote:sha256:' + wasmSha256;
  const routes = new Map(owners.map(({ owner, quotes }) => [owner, { app: appName(wasmSha256, owner), quotes }]));
  if (new Set([...routes.values()].map(route => route.app)).size !== owners.length) throw new Error('Duplicate spared quote owner or app');
  const routeFor = (owner: string) => {
    const route = routes.get(owner);
    if (!route) throw new PermissionDenied('Synthetic spared source is unavailable for this owner');
    return route;
  };
  return {
    functions: [{
      definition: quoteDefinition,
      implementationId,
      async handler(input, context) {
        const { quoteId } = quoteInput.parse(input);
        const route = routeFor(context.principal.owner);
        const fixture = Object.hasOwn(route.quotes, quoteId) ? route.quotes[quoteId] : undefined;
        if (!fixture) throw new NotFound('Synthetic quote fixture not found');
        const quote = await normalizeSparedQuote(port, route.app, fixture.quote, context.signal).catch(cause => {
          throw new SourceReadFailure('Synthetic spared quote normalization failed', { cause });
        });
        const bindingId = digest([quoteSourceGrant, context.principal.owner]);
        const contentDigest = digest(fixture.quote);
        const id = digest([bindingId, quoteId, fixture.observedAt, contentDigest, implementationId]);
        return { quote, evidence: 'synthetic', receipt: { id, bindingId, observedAt: fixture.observedAt, contentDigest } };
      },
    }],
    sources: new Map([[quoteSourceName, {
      async assertCurrent(owner) { routeFor(owner); },
      async apply(graph, source, input, raw) {
        const { quoteId } = quoteInput.parse(input);
        const { quote, receipt, evidence } = quoteObservation.parse(raw);
        const ref = { type: 'SourceReceipt', id: receipt.id };
        await graph.create(ref, { ...receipt, name: quoteSourceName, tool: quoteDefinition.apiName, evidence: 'fixture' });
        const objects = await ingest(graph, graph.model, source, [{
          id: digest([receipt.id, quoteId]), quoteId, ...quote, evidence, observedAt: receipt.observedAt,
        }]);
        await graph.link({ type: quoteReceiptLink, from: objects[0]!, to: ref });
        return { receipt: ref, objects };
      },
    }]]),
  };
}
