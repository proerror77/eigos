import { lstat, mkdir, open, writeFile, rename } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { Conflict, digest } from '../core/identity.js';
import {
  luckinCreateCapability, luckinEvidence, luckinPreviewCapability, luckinReads, pickupConfirmation,
  pickupCreated, pickupInput, pickupOrderType, pickupQuote,
} from '../ontology/luckin.js';
import { readPrivateSourceFile } from '../core/private-source.js';
import type { OntologyClient } from './client.js';
import { LuckinMcp } from './luckin-mcp.js';

const requestSchema = z.object({
  kind: z.literal('pa-request'), taskId: z.uuid(), requestId: z.uuid(), capability: z.string(),
  input: z.record(z.string(), z.unknown()),
});
const receiptSchema = z.strictObject({
  response: luckinEvidence.extend({ status: z.literal('available'), data: pickupCreated }),
  paymentLink: z.string().optional(), priceChanged: z.boolean(),
});
type Receipt = z.infer<typeof receiptSchema>;
type Result = { response: Record<string, unknown>; paymentLink?: string; priceChanged?: boolean };
type Request = z.infer<typeof requestSchema>;
type Client = Pick<OntologyClient, 'request'>;
export interface LuckinPAOptions {
  ontology: Client;
  provider: LuckinMcp;
  /** Stable, random ID of the PA’s local connection, unique to that PA installation. */
  localConnectionId: string;
  privateDirectory: string;
  /** The PA host asks its human user using these terms, outside the EIGOS execution Agent. */
  confirm?: (preview: z.infer<typeof pickupConfirmation>, signal: AbortSignal) => boolean | Promise<boolean>;
}

export class LuckinPA {
  private readonly connectionRef: string;
  constructor(private readonly options: LuckinPAOptions) {
    if (!isAbsolute(options.privateDirectory) || !/^[0-9a-f]{64}$/.test(options.localConnectionId))
      throw new Conflict('Configure an owned private PA directory and connection identity');
    this.connectionRef = options.provider.connectionRef(options.localConnectionId);
  }

  /** Load the task from EIGOS and reply through the existing authenticated PA continuation. */
  async answer(taskId: string, signal = AbortSignal.timeout(90000), mode: 'read' | 'submit' = 'read') {
    z.uuid().parse(taskId);
    const task = await this.options.ontology.request<{ id: string; state: string; result: unknown }>(`tasks/${taskId}`, undefined, signal);
    const request = requestSchema.parse(task.result);
    if (task.id !== taskId || request.taskId !== taskId || task.state !== 'input-required')
      throw new Conflict('The original Luckin task is not waiting for this PA response');
    const result = await this.read(request, signal, mode);
    const continuation = await this.options.ontology.request(
      `tasks/${taskId}/pa-response`, { requestId: request.requestId, response: result.response }, signal,
    );
    // Payment links are returned only to the PA host that speaks to the user.
    return { continuation, paymentLink: result.paymentLink, priceChanged: result.priceChanged };
  }

  private available(data: unknown) {
    return { status: 'available' as const, connectionRef: this.connectionRef,
      observedAt: new Date().toISOString(), evidence: 'pa_reported' as const, data };
  }

  private async read(request: Request, signal: AbortSignal, mode: 'read' | 'submit'): Promise<Result> {
    const provider = this.options.provider;
    const read = async () => {
      switch (request.capability) {
        case luckinReads.findLuckinShops.capability:
          return provider.shops(luckinReads.findLuckinShops.input.parse(request.input), signal);
        case luckinReads.searchLuckinProducts.capability:
          return provider.search(luckinReads.searchLuckinProducts.input.parse(request.input), signal);
        case luckinReads.readLuckinProduct.capability:
          return provider.product(luckinReads.readLuckinProduct.input.parse(request.input), signal);
        case luckinReads.selectLuckinProductOption.capability:
          return provider.select(luckinReads.selectLuckinProductOption.input.parse(request.input), signal);
        case luckinReads.readLuckinPickupStatus.capability:
          return provider.status(luckinReads.readLuckinPickupStatus.input.parse(request.input).orderId, signal);
        case luckinPreviewCapability: {
          const { coupons, ...quote } = await provider.preview(pickupInput.parse(request.input), signal);
          return pickupQuote.parse({ ...quote, couponDigest: digest(coupons) });
        }
        default:
          throw new Conflict('The PA request is outside the Luckin capabilities');
      }
    };
    if (request.capability === luckinCreateCapability) {
      if (mode !== 'submit' || !this.options.confirm) throw new Conflict('The PA host must present this exact Luckin preview for user confirmation');
      return this.submit(request, signal);
    }
    return { response: this.available(await read()) };
  }

  private async submit(request: Request, signal: AbortSignal): Promise<Result> {
    const preview = pickupConfirmation.parse(request.input);
    const { quote, quoteDigest, order } = preview;
    if (order.type !== pickupOrderType || digest(quote) !== quoteDigest ||
        preview.connectionRef !== this.connectionRef)
      throw new Conflict('The Luckin quote does not belong to this PA connection');
    const key = digest([this.options.localConnectionId, request.taskId]);
    const directory = this.options.privateDirectory, filename = join(directory, key + '.json');
    const dispatchFile = join(directory, key + '.dispatched');
    const receipt = async () => {
      try { return receiptSchema.parse(JSON.parse(await readPrivateSourceFile(filename))); }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
        throw error;
      }
    };
    const result = (stored: Receipt) => {
      if (stored.response.connectionRef !== this.connectionRef || stored.response.data.quoteDigest !== quoteDigest)
        throw new Conflict('This task already submitted a different Luckin pickup preview');
      return { response: stored.response, paymentLink: stored.paymentLink, priceChanged: stored.priceChanged };
    };
    const unresolved = () => new Conflict('The original Luckin submission is unresolved. Check it in Luckin before any further submission');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.mode & 0o077 || info.uid !== process.getuid?.())
      throw new Conflict('The PA order journal requires an owned private directory');
    const previous = await receipt();
    if (previous) return result(previous);
    const claim = await lstat(dispatchFile).catch(error => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    });
    if (claim) throw unresolved();
    const deadline = Date.parse(preview.expiresAt);
    if (deadline <= Date.now()) return { response: { status: 'changed' } };
    if (!await this.options.confirm!(preview, signal)) return { response: { status: 'declined' } };
    if (deadline <= Date.now()) return { response: { status: 'changed' } };

    const provider = this.options.provider;
    const { coupons, ...current } = await provider.preview({ shopId: quote.shop.shopId, items: quote.items, currency: quote.currency }, signal);
    if (digest({ ...current, couponDigest: digest(coupons) }) !== quoteDigest || deadline <= Date.now())
      return { response: { status: 'changed' } };
    let dispatchedAt: string | undefined;
    const beforeDispatch = async () => {
      const task = await this.options.ontology.request<{ id: string; state: string; result: unknown }>(
        `tasks/${request.taskId}`, undefined, signal,
      );
      const waiting = requestSchema.parse(task.result);
      if (task.id !== request.taskId || task.state !== 'input-required' || digest(waiting) !== digest(request))
        throw new Conflict('The original Luckin approval is no longer pending');
      signal.throwIfAborted();
      if (deadline <= Date.now()) throw new Conflict('The Luckin quote expired before dispatch');
      // A lost response can still leave a merchant order. Claim the original task
      // just before the supplier call so a failed handshake does not lock it.
      try {
        const claimed = await open(dispatchFile, 'wx', 0o600);
        try { await claimed.sync(); } finally { await claimed.close(); }
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') throw unresolved();
        throw error;
      }
      if (deadline <= Date.now()) throw new Conflict('The Luckin quote expired before dispatch');
      dispatchedAt = new Date().toISOString();
    };
    const created = await provider.create(quote, coupons, signal, beforeDispatch);
    if (!dispatchedAt) throw new Conflict('The Luckin dispatch was not recorded');
    const { paymentLink, ...data } = created, priceChanged = data.totalMinor !== quote.totalMinor;
    const stored = receiptSchema.parse({
      response: this.available({ ...data, quoteDigest, dispatchedAt, currency: quote.currency }), priceChanged,
      ...(!priceChanged && paymentLink ? { paymentLink } : {}),
    });
    await writeFile(filename + '.pending', JSON.stringify(stored), { mode: 0o600, flag: 'wx' });
    await rename(filename + '.pending', filename);
    return result(stored);
  }
}
