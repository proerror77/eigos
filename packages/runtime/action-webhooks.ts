import { z } from 'zod';
import { Conflict, InvalidInput, PermissionDenied, digest } from '../core/identity.js';
import { classificationSchema, combineClassification } from '../ontology/classification.js';
import type { Ontology } from '../ontology/model.js';
import { sourceWebhookEffectHandler, type ActionEffectDefinition } from '../ontology/schema.js';
import type { Access } from './access.js';
import type { ConfiguredComponentSources } from './component-source-egress.js';
import type { Functions } from './functions.js';
import type { PublishedOntology } from './metadata.js';

export const effectHandlerName = (effect: ActionEffectDefinition) => 'webhook' in effect ? sourceWebhookEffectHandler : effect.handler;
export const isWebhookHandler = (name: string) => name === sourceWebhookEffectHandler;
export const webhookApprovalCapability = 'action.webhook.authorize';
export const webhookApprovalDigest = (model: PublishedOntology, action: string, requestId: string, input: Record<string, unknown>) =>
  digest({ release: model.release, action, requestId, input });

const deliverySchema = z.strictObject({
  input: z.record(z.string(), z.unknown()), classification: classificationSchema,
  body: z.string().max(256 * 1024).optional(),
});

export class ActionSourceWebhooks {
  constructor(private readonly sources: ConfiguredComponentSources, private readonly functions: Functions) {}

  bindings(model: Ontology) {
    const entries = model.resolvedDocument.actionTypes.flatMap(action => (action.effects ?? []).flatMap(effect => {
      if (!('webhook' in effect)) return [];
      const { source, method, path } = effect.webhook;
      return [[source, this.sources.egress.webhookBinding(source, method, path)] as const];
    }));
    return Object.fromEntries(entries);
  }

  private declared(model: PublishedOntology, action: string, name: string) {
    const effect = model.action(action).effects?.find(item => item.name === name);
    if (!effect || !('webhook' in effect)) throw new PermissionDenied('The committed Action has no declared webhook');
    const definition = effect.webhook, binding = model.bindings.webhooks?.[definition.source];
    if (!binding) throw new Conflict('The published Action webhook is unavailable');
    return { definition, binding };
  }

  prepare(model: PublishedOntology, action: string, name: string, input: Record<string, unknown>, access: Access) {
    const { definition, binding } = this.declared(model, action, name);
    const formatter = definition.function ? model.functions.get(definition.function) : undefined;
    access.dispatchSource(model, definition.source);
    if (definition.function) access.function(model, definition.function);
    const classification = combineClassification(access.exportedClassification(), model.document.classification,
      model.action(action).classification, formatter?.classification);
    if (this.sources.egress.webhookBinding(definition.source, definition.method, definition.path, classification) !== binding)
      throw new Conflict('The published webhook connection changed');
    return deliverySchema.parse({ input, classification });
  }

  async deliver(model: PublishedOntology, action: string, name: string, payload: unknown, access: Access, id: string,
    signal: AbortSignal, authorize: () => Promise<void>, persistBody: (body: string) => Promise<void>) {
    const { definition, binding } = this.declared(model, action, name);
    const delivery = deliverySchema.parse(payload);
    const check = async () => {
      signal.throwIfAborted();
      await authorize();
      access.action(model, action);
      access.dispatchSource(model, definition.source);
      if (definition.function) access.function(model, definition.function);
    };
    await check();
    let body = delivery.body;
    if (body === undefined) {
      const output = definition.function
        ? await this.functions.formatWebhook(model, definition.function, delivery.input, access, signal)
        : delivery.input;
      const result = z.record(z.string(), z.unknown()).safeParse(output);
      if (!result.success) throw new InvalidInput('A webhook body must be a JSON object');
      body = JSON.stringify(result.data);
      if (Buffer.byteLength(body) > 256 * 1024) throw new InvalidInput('An Action webhook body exceeds 256 KiB');
      await persistBody(body);
    }
    const response = await this.sources.egress.send(definition.source, binding,
      { method: definition.method, path: definition.path, body }, {
        mode: 'effect', signal, idempotencyKey: id, classification: delivery.classification, authorize: check,
        secret: name => {
          if (!this.sources.secrets) throw new PermissionDenied('Source credential is unavailable');
          return this.sources.secrets.get(name);
        },
      });
    if (response.status < 200 || response.status >= 300) throw new Conflict('Source webhook delivery was not accepted');
  }
}
