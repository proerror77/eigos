import type { Client } from 'pg';

const schemaPattern = /^eigos_business_[a-z0-9_]{1,40}$/;

/** Create the authority row lock under the migration owner's privileges. The
 * function and PUBLIC revoke are one SQL batch and must be installed before
 * any runtime role receives schema access. Grant EXECUTE separately to a
 * reviewed runtime role; never grant that role authority-table writes. */
export async function installPostgresAuthorityLock(client: Client, schema: string): Promise<void> {
  if (!schemaPattern.test(schema)) throw new Error('Invalid PostgreSQL business schema');
  await client.query(`CREATE FUNCTION "${schema}".eigos_lock_runtime_authority()
    RETURNS TABLE(id text, revision bigint, configuration_digest text)
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
    AS $$ SELECT a.id,a.revision,a.configuration_digest FROM "${schema}".runtime_authority a WHERE a.slot=1 FOR UPDATE $$;
    REVOKE ALL ON FUNCTION "${schema}".eigos_lock_runtime_authority() FROM PUBLIC`);
}
