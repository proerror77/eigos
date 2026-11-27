import type { Database, Sql } from '../../runtime/database.js';

export async function grantVmRuntime(db: Database, role: string, client: Sql) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role)) throw new Error('Invalid runtime role');
  const result = await db.query(
    `SELECT 1 FROM pg_roles WHERE rolname=$1 AND rolcanlogin AND NOT
    (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)
    AND NOT pg_has_role(rolname,current_user,'MEMBER')`,
    [role],
    client,
  );
  if (!result.rowCount) throw new Error('Use a separate unprivileged runtime login');
  const s = db.schema,
    grantee = '"' + role + '"';
  const tables = (names: string) =>
    names
      .split(' ')
      .map((name) => s + '.' + name)
      .join(',');
  await db.query(
    `GRANT USAGE ON SCHEMA ${s} TO ${grantee};
    GRANT INSERT,UPDATE ON ${s}.resource_reservations TO ${grantee};
    GRANT INSERT,DELETE ON ${s}.reservation_dispatches TO ${grantee};
    GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO ${grantee};
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${s} TO ${grantee};
    GRANT SELECT,INSERT,UPDATE,DELETE ON ${tables('objects links source_values object_edits tasks task_turns pa_requests source_calls external_operations scheduled_actions observation_interests action_effects action_undo_requests index_streams index_transactions materializations materialized_links materialized_objects process_notifications workflows workflow_steps workflow_runs object_rules rule_matches change_subscriptions scenarios scenario_actions scenario_sessions scenario_links scenario_objects scenario_approvals semantic_indexes semantic_vectors provider_budgets function_invocations')} TO ${grantee};
    GRANT INSERT ON ${tables('actions action_changes task_inbox_events edit_history link_history change_commits execution_trace machinery_history')} TO ${grantee};
    GRANT INSERT(owner,email_hash), UPDATE(approved_at,revoked_at,email_hash,agent_token_hash) ON ${s}.accounts TO ${grantee};
    GRANT UPDATE(redeemed_by) ON ${s}.member_invitations TO ${grantee};
    GRANT INSERT,DELETE ON ${s}.member_sessions TO ${grantee};
    GRANT INSERT,UPDATE(email_hash,email,purpose,applied_at) ON ${s}.account_applications TO ${grantee};`,
    [],
    client,
  );
}
