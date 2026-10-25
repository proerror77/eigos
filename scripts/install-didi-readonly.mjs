#!/usr/bin/env node
import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { JobStore } from '../dist/packages/core/store.js';

const { values } = parseArgs({ options: { database: { type: 'string' }, 'expected-digest': { type: 'string' }, 'expected-generation': { type: 'string' }, apply: { type: 'boolean', default: false } } });
if (!values.database || !isAbsolute(values.database)) throw new Error('Use an absolute owned private business database');
const stat = lstatSync(values.database);
if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new Error('Use an owned private regular business database');
const store = new JobStore(values.database);
try {
  const before = store.definitions.namespace();
  if (!values.apply) console.log(JSON.stringify({ status: 'prepared', active: before.active, generation: before.generation, operation: 'add_builtin_didi_reads' }));
  else {
    if (values['expected-digest'] !== before.active.digest || values['expected-generation'] !== String(before.generation)) throw new Error('Supply the exact prepared ontology digest and generation');
    const after = store.definitions.installDidiReadonly(before.active, before.generation);
    console.log(JSON.stringify({ status: 'ready', previous: before.active, active: after.active, generation: after.generation, noBusinessActions: true }));
  }
} finally { store.close(); }
