import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { JobStore } from '../core/store.js';
import { MemberStore } from '../members/store.js';
import { AuthorizationCoordinator } from './coordinator.js';
import type { SecurityMode } from './store.js';

/** Local operator interface used by the existing members CLI. It shares the
 * same deny-first coordinator as HTTP; it never acquires a Gateway lease or
 * provisions a grant. Detect persisted mode even when the CLI omitted the flag. */
export function openMembershipAdministration(databasePath: string, membershipPath: string, configuredMode?: string) {
  if (!existsSync(databasePath) || !existsSync(membershipPath) || resolve(databasePath) === resolve(membershipPath)) throw new Error('Membership administration requires the existing separate task and member databases');
  const reader = new DatabaseSync(databasePath, { readOnly: true }); let mode: SecurityMode;
  try {
    const table = reader.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='security_settings'").get();
    if (!table) mode = 'legacy';
    else {
      const row = reader.prepare('SELECT version,mode FROM security_settings WHERE slot=1').get();
      if (!row || row.version !== (row.mode==='foundation'?2:1) || !['legacy', 'foundation'].includes(String(row.mode))) throw new Error('Unknown security database mode');
      mode = row.mode as SecurityMode;
    }
  } finally { reader.close(); }
  if (configuredMode !== undefined && configuredMode !== mode) throw new Error('CLI security mode differs from the database; no bypass or cutover');
  const tasks = new JobStore(databasePath, { securityMode: mode });
  let members: MemberStore;
  try { members = new MemberStore(membershipPath); } catch (error) { tasks.close(); throw error; }
  const coordinator = mode === 'foundation' ? new AuthorizationCoordinator(tasks.security, members) : undefined;
  return { members, mode,
    setStatus: (id: string, status: 'active' | 'suspended') => coordinator ? coordinator.setMemberStatus(id, status) : members.setStatus(id, status),
    pending: () => tasks.security.pendingFences().length,
    close: () => { members.close(); tasks.close(); } };
}
