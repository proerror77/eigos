import type { Client } from 'pg';
import { DomainError, requireScope, type Principal } from '../core/domain.js';
import { currentKernelImplementation } from '../ontology/definition-store.js';
import { stagedKernelComponents, type StagedKernelBuilder } from '../ontology/seed-definition.js';
import { describeDefinitionCatalogue, type DefinitionDescriptionInput } from '../security/definition-view.js';
import { reviewedFieldPolicy } from '../security/field-policy.js';
import { projectionFields } from '../security/projections.js';
import { roleAllows, roleSchema } from '../security/resource-role.js';
import { secureDescribeSchema } from '../security/view-contracts.js';
import { SecurityError } from '../security/errors.js';
import { postgresBusinessSchema, postgresConstrainReadDeadline } from './runtime-transaction.js';
import { postgresTaskReadOntology, withPostgresAgentMetadata, withPostgresTaskReadSnapshot,
  type PostgresTaskReadAdmission } from './task-read-access.js';

/** Definition metadata only. No object values, source credentials or execution
 * authority are introduced by discovery. Both adapters use the same filter. */
export async function postgresDescribeOntology(client: Client, principal: Principal, input: unknown,
  policyDigest: string, builder?: StagedKernelBuilder) {
  const captured = structuredClone(principal), { taskId, ...args } = secureDescribeSchema.parse(input);
  requireScope(captured, 'services:read');
  const model = builder === undefined ? currentKernelImplementation() : stagedKernelComponents(builder).model;
  const describe = async (admission: Pick<PostgresTaskReadAdmission, 'actor' | 'parent'>,
    options: DefinitionDescriptionInput) => {
    const selected = taskId ? (await postgresTaskReadOntology(client, captured, taskId, policyDigest, builder)).model : model;
    const rows = await client.query(`SELECT CASE WHEN octet_length(body)<=65536 THEN body END AS body
      FROM "${postgresBusinessSchema(client)}".security_roles WHERE subject_id IN ($1,$2) LIMIT 257`,
    [admission.actor.memberId, admission.actor.installationId]);
    if (rows.rows.length > 256 || rows.rows.some(row => row.body === null)) throw new DomainError('CONFLICT', 'Resource role read bound exceeded');
    const roles = rows.rows.map(row => roleSchema.parse(JSON.parse(String(row.body)))), now = Date.now();
    let validUntil = Infinity;
    const result = describeDefinitionCatalogue({ model, parent: admission.parent,
      resourceAllowed(kind, id) {
        const matching = roles.filter(role => roleAllows(model, [role], admission.actor.memberId,
          admission.actor.installationId, kind, id, 'resource.view', () => now));
        if (!matching.length) return false;
        validUntil = Math.min(validUntil, Math.max(...matching.map(role => Date.parse(role.expiresAt))));
        return true;
      },
      fields: type => ({ ...model.properties(type), ...projectionFields(type) }),
      fieldPolicy: (type, field) => reviewedFieldPolicy(model, type, field),
    }, options, selected);
    if (validUntil <= Date.now()) throw new SecurityError('AUTHORIZATION_REQUIRED');
    if (Number.isFinite(validUntil)) postgresConstrainReadDeadline(client, validUntil);
    return result;
  };
  return taskId ? withPostgresTaskReadSnapshot(client, captured, taskId, policyDigest, admission => {
    if (!admission.grant.operations.includes('task.query')) throw new SecurityError('AUTHORIZATION_REQUIRED');
    return describe(admission, args);
  }) : withPostgresAgentMetadata(client, captured, policyDigest, admission => describe(admission, args));
}
