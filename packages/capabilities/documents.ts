import { createHash } from 'node:crypto';
import { Conflict, digest } from '../core/identity.js';
import { classificationSchema } from '../ontology/classification.js';
import { documentChunkLink, documentChunkType, documentLink, documentType } from '../ontology/documents.js';
import { objectRefSchema } from '../ontology/schema.js';
import type { FunctionHandler } from '../runtime/functions.js';

type Location = { startOffset: number; endOffset: number; page?: number; paragraph?: number };
function segments(text: string, locations: Location[]) {
  const characters = Array.from(text), ranges: Location[] = [];
  let previous = 0;
  for (const location of locations) {
    if (location.startOffset < previous || location.startOffset >= location.endOffset || location.endOffset > characters.length)
      throw new Conflict('Document locations must be ordered, disjoint and inside the extracted text');
    if (location.startOffset > previous) ranges.push({ startOffset: previous, endOffset: location.startOffset });
    ranges.push(location);
    previous = location.endOffset;
  }
  if (previous < characters.length) ranges.push({ startOffset: previous, endOffset: characters.length });
  const output: (Location & { text: string })[] = [];
  for (const { startOffset, endOffset, ...location } of ranges) {
    for (let start = startOffset; start < endOffset;) {
      let end = Math.min(start + 1500, endOffset);
      if (!locations.length && end < endOffset) {
        for (let boundary = end; boundary >= start + 1000; boundary--) {
          if (/[\n.!?。！？]/u.test(characters[boundary - 1]!)) {
            end = boundary;
            break;
          }
        }
      }
      const text = characters.slice(start, end).join('');
      if (text.trim()) output.push({ startOffset: start, endOffset: end, text, ...location });
      start = end;
    }
  }
  return output;
}

export const registerSchedulePlanDocument: FunctionHandler = async (input, context) => {
  if (context.objects.model.scenario) throw new Conflict('Register document versions on the live Ontology');
  if (!context.edit) throw new Conflict('A published Action is required to register a document');
  const { plan, documentKey, edition, extractedText, classification: rawLabel, locationRanges, ...metadata } = input;
  const parent = objectRefSchema.parse(plan), text = String(extractedText);
  const document = { type: documentType, id: digest([documentKey, edition]) };
  const textSha256 = createHash('sha256').update(text, 'utf8').digest('hex');
  const classification = rawLabel === undefined ? undefined : classificationSchema.parse(rawLabel);
  const chunks = segments(text, (locationRanges ?? []) as Location[]);
  return context.edit(document, async graph => {
    await graph.read(parent);
    await graph.create(document, { ...metadata, id: document.id, documentKey, edition, extractedText: text, textSha256, classification, locationRanges });
    await graph.link({ type: documentLink, from: parent, to: document });
    for (const [index, chunk] of chunks.entries()) {
      const ref = { type: documentChunkType, id: digest([document.id, chunk.startOffset, chunk.endOffset]) };
      await graph.create(ref, { id: ref.id, documentId: document.id, index, name: String(metadata.name), classification, ...chunk });
      await graph.link({ type: documentChunkLink, from: document, to: ref });
    }
  });
};
