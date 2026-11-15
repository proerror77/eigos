import { createHash } from 'node:crypto';
import { Conflict, digest } from '../core/identity.js';
import { documentLink, documentType } from '../ontology/documents.js';
import { objectRefSchema } from '../ontology/schema.js';
import type { FunctionHandler } from '../runtime/functions.js';

export const registerSchedulePlanDocument: FunctionHandler = async (input, context) => {
  if (!context.edit) throw new Conflict('A published Action is required to register a document');
  const { plan, documentKey, edition, extractedText, ...metadata } = input;
  const parent = objectRefSchema.parse(plan), text = String(extractedText);
  const document = { type: documentType, id: digest([documentKey, edition]) };
  const textSha256 = createHash('sha256').update(text, 'utf8').digest('hex');
  return context.edit(document, async graph => {
    await graph.read(parent);
    await graph.create(document, { ...metadata, id: document.id, documentKey, edition, extractedText: text, textSha256 });
    await graph.link({ type: documentLink, from: parent, to: document });
  });
};
