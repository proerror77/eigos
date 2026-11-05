import { digest } from '../core/delegation.js';
import type { DefinitionCompatibilityInput } from './definition-store.js';
import type { OntologyModel } from './model.js';

/** Compare the trusted implementations on both sides of a persisted fact. */
export function compatibleDefinitionModels(original: OntologyModel, target: OntologyModel, input: DefinitionCompatibilityInput): boolean {
  try {
    if (input.kind === 'link') {
      const old = original.link(input.id), current = target.link(input.id);
      return digest(old) === input.storedDigest && digest(current) === input.currentDigest && digest({ from: old.from, to: old.to, writePolicy: old.writePolicy }) === digest({ from: current.from, to: current.to, writePolicy: current.writePolicy });
    }
    if (!input.properties || original.fingerprint(input.id) !== input.storedDigest || target.fingerprint(input.id) !== input.currentDigest) return false;
    const old = original.object(input.id), current = target.object(input.id);
    if (old.primaryKey !== current.primaryKey || old.titleKey !== current.titleKey || original.objectWritePolicy(input.id) !== target.objectWritePolicy(input.id)) return false;
    const before = original.parseProperties(input.id, input.properties), after = target.parseProperties(input.id, input.properties);
    return digest(before) === digest(input.properties) && digest(after) === digest(input.properties);
  } catch { return false; }
}
