import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { nameSchema, type OntologyModel } from '../ontology/model.js';
import { consentDeadline,consentExpirySchema } from './consent-lifetime.js';
import { resourceDefaults, resourceRefSchema } from './contracts.js';

const id = z.string().min(1).max(200), instant = z.iso.datetime({ offset: true });
export const legacyRoleSchema = z.strictObject({ subjectKind: z.enum(['member', 'installation']), subjectId: z.uuid(),
  resource: z.union([resourceRefSchema, z.strictObject({ kind: z.literal('namespace'), id, version: id })]),
  role: z.enum(['Viewer', 'Editor', 'Owner']), executeActions: z.array(nameSchema).max(100).default([]),
  invokeFunctions: z.array(nameSchema).max(100).default([]), expiresAt: instant });
export const roleSchema = legacyRoleSchema.extend({expiresAt:consentExpirySchema});

export function resourceVersion(model: OntologyModel, kind: string, id: string): string {
  if (kind === 'objectType') return model.object(id).version;
  if (kind === 'interface') return digest(model.describeType(id));
  if (kind === 'function') return model.function(id).version;
  return digest(kind === 'actionType' ? model.action(id) : model.link(id));
}

export function roleAllows(model: OntologyModel, roles: z.infer<typeof roleSchema>[], memberId: string, installationId: string,
  kind: string, id: string, permission: string, now: () => number): boolean {
  let version: string; try { version = resourceVersion(model,kind,id); } catch { return false; }
  return roles.some(value => {
    const ref = value.resource;
    if (consentDeadline(value.expiresAt) <= now() || (value.subjectKind === 'member' ? value.subjectId !== memberId : value.subjectId !== installationId)) return false;
    const matches = ref.kind === 'namespace' ? ref.id === model.ref.id && ref.version === model.ref.digest : ref.kind === kind && ref.id === id && ref.version === version;
    return matches && (permission === 'action.execute' ? value.executeActions.includes(id) : permission === 'function.invoke' ? value.invokeFunctions.includes(id) : (resourceDefaults[value.role] as readonly string[]).includes(permission));
  });
}
