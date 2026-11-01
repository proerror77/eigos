import type { Client } from 'pg';

const businessPattern = /^eigos_business_[a-z0-9_]{1,40}$/;
const membershipPattern = /^eigos_membership_[a-z0-9_]{1,40}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

/** Compare active projected identities with the imported membership snapshot.
 * This read-only check never activates a runtime or establishes authorization. */
export async function auditImportedIdentities(client: Client, options: {
  businessSchema: string; membershipSchema: string; businessFileDigest: string; membershipFileDigest: string; now: number;
}) {
  const { businessSchema, membershipSchema, businessFileDigest, membershipFileDigest, now } = options;
  if (!businessPattern.test(businessSchema) || !membershipPattern.test(membershipSchema) || !digestPattern.test(businessFileDigest) || !digestPattern.test(membershipFileDigest) || !Number.isSafeInteger(now) || now < 0) throw new Error('Invalid identity audit options');
  const business = quote(businessSchema), membership = quote(membershipSchema);
  let open = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); open = true;
    for (const [schema, table, expected] of [[business, 'eigos_migration_receipt', businessFileDigest], [membership, 'eigos_membership_migration_receipt', membershipFileDigest]]) {
      const result = await client.query(`SELECT body FROM ${schema}.${quote(table!)} WHERE slot=1`);
      const body = result.rows[0]?.body;
      if (result.rowCount !== 1 || !body || body.version !== 1 || body.status !== 'imported-not-activated' || body.sourceFileDigest !== expected) throw new Error('Migration receipt does not match the reviewed snapshot');
    }
    const rows = await client.query(`SELECT s.owner,s.member_id,s.client_id,s.installation_id,
      m.issuer,m.tenant,m.subject,m.status,m.accepted_at,r.member_id AS registration_member,r.client_id AS registration_client,r.revoked,c.blocked
      FROM ${business}.security_subjects s
      LEFT JOIN ${membership}.agent_registrations r ON r.id=s.installation_id
      LEFT JOIN ${membership}.members m ON m.id=s.member_id
      LEFT JOIN ${membership}.member_connections c ON c.member_id=s.member_id AND c.client_id=s.client_id
      WHERE s.state='active' AND s.valid_until > $1 ORDER BY s.installation_id LIMIT 50001`, [now]);
    if (rows.rows.length > 50000) throw new Error('Identity audit row limit exceeded');
    let mismatched = 0;
    for (const row of rows.rows) {
      const valid = typeof row.issuer === 'string' && typeof row.tenant === 'string' && typeof row.subject === 'string'
        && row.owner === JSON.stringify([row.issuer,row.tenant,row.subject]) && row.status === 'active' && row.accepted_at !== null
        && row.registration_member === row.member_id && row.registration_client === row.client_id && String(row.revoked) === '0'
        && (row.blocked === null || String(row.blocked) === '0');
      if (!valid) mismatched++;
    }
    await client.query('COMMIT'); open = false;
    return { version: 1 as const, status: 'audit-only' as const, checkedAt: now, activeSubjects: rows.rows.length, mismatchedSubjects: mismatched, runtimeActivated: false as const };
  } catch (error) { if (open) await client.query('ROLLBACK'); throw error; }
}
