import {postgresConsentDeadline,postgresConsentIndex} from './consent.js';
import type { Client } from 'pg';
import { DomainError, requireScope, type Principal } from '../core/domain.js';
import { currentKernelImplementation } from '../ontology/definition-store.js';
import { stagedKernelComponents, type StagedKernelBuilder } from '../ontology/seed-definition.js';
import { describeDefinitionCatalogue, type DefinitionAccess } from '../security/definition-view.js';
import type { OntologyModel } from '../ontology/model.js';
import { reviewedFieldPolicy } from '../security/field-policy.js';
import { projectionFields } from '../security/projections.js';
import { roleAllows, roleSchema } from '../security/resource-role.js';
import { secureDescribeSchema } from '../security/view-contracts.js';
import { SecurityError } from '../security/errors.js';
import {assertReviewedModel} from '../security/model-review.js';
import { postgresBusinessSchema, postgresBusinessToken, postgresConstrainReadDeadline } from './runtime-transaction.js';
import { postgresTaskReadOntology, withPostgresAgentMetadata, withPostgresTaskReadSnapshot,
  withPostgresTaskReadGrant, type PostgresTaskReadAdmission } from './task-read-access.js';

async function withDefinitionAccess<T>(client: Client, admission: Pick<PostgresTaskReadAdmission, 'actor' | 'parent'>,
  model: OntologyModel, policyDigest:string, action: (access: DefinitionAccess) => Promise<T>,policyModel:OntologyModel=model): Promise<T> {
  const token = postgresBusinessToken(client);
  const rows = await client.query(`SELECT CASE WHEN octet_length(body)<=65536 THEN body END AS body
    FROM "${postgresBusinessSchema(client)}".security_roles WHERE subject_id IN ($1,$2) LIMIT 257`,
  [admission.actor.memberId, admission.actor.installationId]);
  if (rows.rows.length > 256 || rows.rows.some(row => row.body === null)) throw new DomainError('CONFLICT', 'Resource role read bound exceeded');
  const roles = rows.rows.map(row => {const role=roleSchema.parse(JSON.parse(String(row.body)));postgresConsentDeadline(role.expiresAt,policyDigest,policyModel);return role;});
  let available = true, validUntil = Infinity;
  const active = () => {
    if (!available || postgresBusinessToken(client) !== token || validUntil <= Date.now()) throw new SecurityError('AUTHORIZATION_REQUIRED');
  };
  const access: DefinitionAccess = { model, parent: { resources: structuredClone(admission.parent.resources) },
    resourceAllowed(kind, id) {
      active(); const now = Date.now();
      const matching = roles.filter(role => roleAllows(model, [role], admission.actor.memberId,
        admission.actor.installationId, kind, id, 'resource.view', () => now));
      if (!matching.length) return false;
      validUntil = Math.min(validUntil, Math.max(...matching.map(role => postgresConsentIndex(role.expiresAt,policyDigest,policyModel))));
      postgresConstrainReadDeadline(client, validUntil); return true;
    },
    fields(type) { active(); return { ...model.properties(type), ...projectionFields(type) }; },
    fieldPolicy(type, field) { active(); return reviewedFieldPolicy(model, type, field); },
  };
  try { const result = await action(access); active(); return result; }
  finally { available = false; }
}

/** Internal admitted task metadata. A processing-only Worker retains its own
 * actor/operation; public Agent discovery keeps its separate services scope. */
export async function withPostgresTaskDefinitionAccess<T>(client: Client, principal: Principal, taskId: string,
  policyDigest: string, action: (access: DefinitionAccess, selected: OntologyModel) => Promise<T>, builder?: StagedKernelBuilder): Promise<T> {
  const captured = structuredClone(principal);
  return withPostgresTaskReadGrant(client, captured, taskId, policyDigest, async admission => {
    if (!admission.grant.operations.includes(admission.actor.actorKind === 'worker' ? 'task.process' : 'task.query')) throw new SecurityError('AUTHORIZATION_REQUIRED');
    const selected = (await postgresTaskReadOntology(client, captured, taskId, policyDigest, builder)).model;
    const model = builder === undefined ? currentKernelImplementation() : stagedKernelComponents(builder).model;
    if(model.ref.version==='29')assertReviewedModel(model,selected);
    return withDefinitionAccess(client, admission, model.ref.version==='29'?selected:model, policyDigest, access => action(access, selected),model);
  });
}

/** Definition metadata only. No object values, source credentials or execution
 * authority are introduced by discovery. Both adapters use the same filter. */
export async function postgresDescribeOntology(client: Client, principal: Principal, input: unknown,
  policyDigest: string, builder?: StagedKernelBuilder) {
  const captured = structuredClone(principal), { taskId, ...args } = secureDescribeSchema.parse(input);
  requireScope(captured, 'services:read');
  const model = builder === undefined ? currentKernelImplementation() : stagedKernelComponents(builder).model;
  const describe = async (admission: Pick<PostgresTaskReadAdmission, 'actor' | 'parent'>, contextTypes: readonly string[] = []) => {
    const selected = taskId ? (await postgresTaskReadOntology(client, captured, taskId, policyDigest, builder)).model : model;
    return withDefinitionAccess(client, admission, model, policyDigest, async access => describeDefinitionCatalogue(access, args, selected, contextTypes));
  };
  return taskId ? withPostgresTaskReadSnapshot(client, captured, taskId, policyDigest, admission => {
    if (!admission.grant.operations.includes('task.query')) throw new SecurityError('AUTHORIZATION_REQUIRED');
    return describe(admission, admission.grant.inputs.map(input => input.object.type));
  }) : withPostgresAgentMetadata(client, captured, policyDigest, describe);
}
