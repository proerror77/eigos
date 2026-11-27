import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { grantVmRuntime } from '../packages/solutions/eigos/vm-role.js';
import { digest } from '../packages/core/identity.js';
import { Ontology } from '../packages/ontology/model.js';
import { Access } from '../packages/runtime/access.js';
import { openInstallation, checkInstallation } from '../packages/runtime/open-installation.js';
import { installOwnerIsolation } from '../packages/runtime/owner-isolation.js';
import { upgradePublicationStorage } from '../packages/runtime/upgrade.js';
import pg from 'pg';
import { KernelClient } from '../packages/runtime/kernel/client.js';
import { FunctionHostClient } from '../packages/function-host/client.js';
import { eigosInstallation } from '../packages/solutions/eigos/installation.js';
import { eigosApp } from './gateway/app.js';
import { startGateway } from './gateway/start.js';
import { startIndexer } from './indexer/start.js';
import { startWorker } from './worker/start.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const command = process.argv[2];
if (!command || !['install', 'upgrade', 'verify', 'gateway', 'worker', 'indexer'].includes(command))
  throw new Error('Choose install, upgrade, verify, gateway, worker or indexer');
const instance = z.uuid().parse(process.env.EIGOS_INSTALLATION_ID);
const roleName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const runtimeRole = roleName.parse(process.env.EIGOS_RUNTIME_ROLE);
const state = process.env.EIGOS_STATE_DIR;
if (!state || !isAbsolute(state))
  throw new Error('Set EIGOS_STATE_DIR to this installation’s private state directory');
for (const variable of [
  'EIGOS_EXTENSION_MODULE',
  'QUERY_DATABASE_URL',
  'EIGOS_KERNEL_URL',
  'EIGOS_FUNCTION_HOST_URL',
])
  if (process.env[variable])
    throw new Error(variable + ' is outside the single-database local-execution VM profile');
const release = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'));
const model = new Ontology(JSON.parse(await readFile(join(root, 'ontology.json'), 'utf8')));
if (
  release.format !== 'eigos-vm-v1' ||
  release.ontology.id !== model.document.id ||
  model.digest !== release.ontology.digest
)
  throw new Error('Installed Ontology differs from the release');
await mkdir(state, { recursive: true, mode: 0o700 });
const receipt = join(state, 'installation.json');
const native = release.native;
if (native) {
  process.env.EIGOS_KERNEL = 'route';
  process.env.EIGOS_KERNEL_BIN = join(root, 'bin/kernel');
  process.env.EIGOS_FUNCTION_HOST_BIN = join(root, 'bin/function-host');
  for (const [key, name] of [
    ['EIGOS_KERNEL_DATA', 'kernel'],
    ['EIGOS_FUNCTION_HOST_DATA', 'functions'],
  ] as const) {
    const path = join(state, command, name);
    await mkdir(path, { recursive: true, mode: 0o700 });
    process.env[key] = path;
  }
} else {
  process.env.EIGOS_KERNEL = 'off';
  delete process.env.EIGOS_KERNEL_BIN;
  delete process.env.EIGOS_FUNCTION_HOST_BIN;
}
const installation = await eigosInstallation();
installation.model = model;
installation.expectedDefinition = model.digest;
installation.runtimeId = (core) => digest([core, release.engine, release.solution]);
process.env.EIGOS_SOURCE_COMMIT = release.source;
if (
  z.enum(['harness', 'actions-only']).default('harness').parse(process.env.EIGOS_MODEL_MODE) === 'actions-only'
) {
  installation.driver = () => ({
    model: 'actions-only',
    async run() {
      throw new Error('Configure the installation model for natural-language tasks');
    },
  });
}

const { db, metadata } = openInstallation(installation);
const installing = command === 'install' || command === 'upgrade';
const lock = installing ? await db.pool.connect() : undefined;
try {
  if (lock) await lock.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [db.lockKey('vm-install')]);
  const prior = await readFile(receipt, 'utf8')
    .then(JSON.parse)
    .catch((error) => {
      if (error.code !== 'ENOENT' || command !== 'install') throw error;
      return undefined;
    });
  const storage = async () =>
    (
      await db.query(
        `SELECT id,instance,current_database() AS database,current_setting('server_version_num') AS postgres FROM ${db.schema}.storage_identity CROSS JOIN ${db.schema}.vm_installation`,
      )
    ).rows[0]!;
  if (prior) {
    const actual = await storage();
    if (
      prior.instance !== instance ||
      prior.instance !== actual.instance ||
      prior.storage !== actual.id ||
      prior.runtimeRole !== runtimeRole ||
      prior.database !== actual.database
    )
      throw new Error('Database does not match the installation receipt');
  }
  if (installing) {
    const marker = (await db.query('SELECT to_regclass($1) AS id', [db.schema + '.vm_installation'])).rows[0]!.id;
    if (
      marker &&
      !(await db.query(`SELECT 1 FROM ${db.schema}.vm_installation WHERE instance=$1`, [instance])).rowCount
    )
      throw new Error('Database is registered to another installation');
    if (!marker && (await db.query('SELECT to_regclass($1) AS id', [db.schema + '.storage_identity'])).rows[0]!.id)
      throw new Error('Use a fresh installation database');
    if (native) {
      const kernel = await KernelClient.start(process.env.EIGOS_KERNEL_BIN!);
      try {
        if ((await kernel.health()).protocol !== native.kernel.protocol)
          throw new Error('Incompatible Query Kernel');
      } finally {
        await kernel.stop();
      }
      const host = await FunctionHostClient.start(process.env.EIGOS_FUNCTION_HOST_BIN!);
      try {
        const health = await host.health(AbortSignal.timeout(10000));
        if (health.protocol !== native['function-host'].protocol || health.world !== native['function-host'].world)
          throw new Error('Incompatible Function Host');
      } finally {
        await host.stop();
      }
    }
    await db.transaction(async (client) => {
      await db.query(
        `CREATE SCHEMA IF NOT EXISTS ${db.schema};
        CREATE TABLE IF NOT EXISTS ${db.schema}.vm_installation(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),instance uuid NOT NULL)`,
        [],
        client,
      );
      await db.query(
        `INSERT INTO ${db.schema}.vm_installation(instance) VALUES($1) ON CONFLICT DO NOTHING`,
        [instance],
        client,
      );
    });
    if (command === 'upgrade') await upgradePublicationStorage(db);
    else await db.initialize();
    const publisher = { owner: process.env.EIGOS_PUBLISHER_SUBJECT ?? 'deployment', scopes: [] };
    await db.query(
      `INSERT INTO ${db.schema}.resource_grants(subject,resource,permission) VALUES($1,$2,'manage_definition') ON CONFLICT DO NOTHING`,
      [publisher.owner, model.document.id],
    );
    const present = (await db.query(`SELECT release FROM ${db.schema}.ontology WHERE id=$1`, [model.document.id]))
      .rows[0];
    let active = present ? await metadata.get(present.release) : undefined;
    if (!active || active.digest !== model.digest || active.runtimeId !== db.runtimeId) {
      if (active && command !== 'upgrade') throw new Error('Use upgrade for an existing publication');
      active = await metadata.publish(model.document, installation.assemble(db), await Access.load(db, publisher));
    }
    await installation.afterActivation?.(db, active);
    await installOwnerIsolation(db);
    await db.transaction((client) => grantVmRuntime(db, runtimeRole, client));
    if (native) {
      const role = z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,62}$/)
        .parse(process.env.EIGOS_KERNEL_ROLE);
      if (
        !(
          await db.query(
            'SELECT 1 FROM pg_roles WHERE rolname=$1 AND rolcanlogin AND rolbypassrls AND NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication)',
            [role],
          )
        ).rowCount
      )
        throw new Error('Use a dedicated read-only projection login with BYPASSRLS');
      await db.query(`GRANT USAGE ON SCHEMA ${db.schema} TO "${role}";
        GRANT SELECT ON ${['storage_identity', 'vm_installation', 'objects', 'links', 'releases', 'edit_history', 'link_history', 'change_commits', 'scenarios', 'scenario_objects', 'scenario_links'].map((t) => db.schema + '.' + t).join(',')} TO "${role}"`);
    }
    const actual = await storage();
    const result = {
      ...release,
      instance,
      runtimeRole,
      kernelRole: native ? process.env.EIGOS_KERNEL_ROLE : undefined,
      storage: actual.id,
      database: actual.database,
      schema: db.schema.slice(1, -1),
      postgres: actual.postgres,
      release: active.release,
      projection: active.projection,
      bindings: digest(active.bindings),
      runtime: db.runtimeId,
    };
    // A role can only start after the complete installation has an atomic receipt.
    const temp = receipt + '.' + randomUUID();
    await writeFile(temp, JSON.stringify(result) + '\n', { mode: 0o600 });
    await rename(temp, receipt);
    console.log(JSON.stringify(result));
  } else {
    if (
      (await db.query('SELECT current_user AS role')).rows[0]!.role !== prior.runtimeRole ||
      runtimeRole !== prior.runtimeRole
    )
      throw new Error('Run services using the installed runtime role');
    if (process.env.EIGOS_ENFORCE_OWNER_RLS !== 'true') throw new Error('VM services require owner isolation');
    const active = await metadata.active();
    if (
      prior.release !== active.release ||
      prior.projection !== active.projection ||
      prior.runtime !== db.runtimeId ||
      prior.bindings !== digest(active.bindings)
    )
      throw new Error('Active publication differs from the installation receipt');
    if (native) {
      if (!process.env.EIGOS_KERNEL_DATABASE_URL)
        throw new Error('Configure the private kernel database connection');
      const reader = new pg.Client({
        connectionString: process.env.EIGOS_KERNEL_DATABASE_URL,
        connectionTimeoutMillis: 5000,
      });
      await reader.connect();
      try {
        const {
          rows: [identity],
        } = await reader.query(
          `SELECT id,instance,current_user AS role FROM ${db.schema}.storage_identity CROSS JOIN ${db.schema}.vm_installation`,
        );
        if (identity?.id !== prior.storage || identity.instance !== instance || identity.role !== prior.kernelRole)
          throw new Error('Kernel database does not match the installation receipt');
      } finally {
        await reader.end();
      }
    }
    await checkInstallation(installation, metadata, installation.assemble(db));
    if (command === 'verify') {
      if (native) {
        const kernel = await KernelClient.start(process.env.EIGOS_KERNEL_BIN!);
        try {
          await kernel.load(db, active, process.env.EIGOS_KERNEL_DATABASE_URL!);
          if ((await kernel.health()).projection !== active.projection)
            throw new Error('Kernel loaded another projection');
          await kernel.checkpoint();
        } finally {
          await kernel.stop();
        }
      }
      console.log(JSON.stringify(prior));
    }
  }
} finally {
  if (lock) {
    try {
      await lock.query('SELECT pg_advisory_unlock_all()');
    } finally {
      lock.release();
    }
  }
  await db.close();
}
if (command === 'gateway') await startGateway(installation, eigosApp);
if (command === 'worker') await startWorker(installation);
if (command === 'indexer') await startIndexer(installation);
