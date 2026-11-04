#!/usr/bin/env node
import { lstatSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { DefinitionStore } from '../dist/packages/ontology/definition-store.js';
import { PAYMENT_COMMERCE_KERNEL_MODEL_REF } from '../dist/packages/ontology/seed-definition.js';
import { upgradeBusinessDescriptionsPolicy } from '../dist/packages/security/business-descriptions-upgrade.js';
import { businessTransaction } from '../dist/packages/core/transaction.js';
import { readRuntimeAuthority, storedRuntimeAuthority, runtimeAuthorityMatches } from '../dist/packages/core/runtime-authority.js';

const { values } = parseArgs({ options: { database: { type: 'string' }, 'expected-digest': { type: 'string' }, 'expected-generation': { type: 'string' },
  'expected-policy-digest': { type: 'string' }, 'expected-policy-revision': { type: 'string' }, apply: { type: 'boolean', default: false } } });
if (!values.database || !isAbsolute(values.database)) throw new Error('Use an absolute owned private business database');
const stat = lstatSync(values.database);
if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new Error('Use an owned private regular business database');
const db = new DatabaseSync(values.database);
try {
  const authority = process.env.EIGOS_AUTHORITY_FILE ? readRuntimeAuthority(process.env.EIGOS_AUTHORITY_FILE) : undefined, installed = storedRuntimeAuthority(db);
  if (installed && (!authority || !runtimeAuthorityMatches(db, authority) || resolve(values.database) !== resolve(authority.databasePath)) || !installed && authority) throw new Error('Exact installed primary authority required');
  const definitions = new DefinitionStore(db, Date.now, { readOnly: true }), before = definitions.namespace();
  if (definitions.resolve(before.active).model.ref.digest !== PAYMENT_COMMERCE_KERNEL_MODEL_REF.digest) throw new Error('Business descriptions require the exact reviewed v27 predecessor');
  const foundation = db.prepare('SELECT mode FROM security_settings WHERE slot=1').get()?.mode === 'foundation';
  const policy = foundation ? { digest: String(db.prepare('SELECT digest FROM security_policy_definitions WHERE slot=1').get()?.digest),
    revision: Number(db.prepare('SELECT revision FROM security_policy WHERE slot=1').get()?.revision) } : undefined;
  if (!values.apply) {
    console.log(JSON.stringify({ status: 'prepared', active: before.active, generation: before.generation, policy,
      ...(policy ? { policyUpgrade: upgradeBusinessDescriptionsPolicy(db, policy) } : {}), descriptions: 68, noBusinessActions: true }));
  } else {
    if (values['expected-digest'] !== before.active.digest || values['expected-generation'] !== String(before.generation)
      || policy && (values['expected-policy-digest'] !== policy.digest || values['expected-policy-revision'] !== String(policy.revision))) throw new Error('Supply the exact prepared ontology and policy preconditions');
    const result = businessTransaction(db, () => {
      if (db.prepare('SELECT 1 FROM work_claims WHERE expires_at>?').get(Date.now())) throw new Error('Stop Worker before installing descriptions');
      const policyUpgrade = policy ? upgradeBusinessDescriptionsPolicy(db, policy, true) : undefined;
      const after = new DefinitionStore(db).installBusinessDescriptions(before.active, before.generation);
      return { status: 'ready', previous: before.active, active: after.active, generation: after.generation, policyUpgrade, noBusinessActions: true };
    });
    console.log(JSON.stringify(result));
  }
} finally { db.close(); }
