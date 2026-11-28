import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectedInstallation } from '../apps/installation.js';
import { Access } from '../packages/runtime/access.js';
import type { ProjectionTransform } from '../packages/runtime/metadata.js';
import { openInstallation } from '../packages/runtime/open-installation.js';
import { manageInstallation } from './manage-installation.js';

const args = process.argv.slice(2);
if (process.env.EIGOS_SOLUTION_MANIFEST === undefined &&
    ['invite', 'account', 'enable-pgvector', 'provision-public-places', 'replay-check', 'archive-logs', 'audit', 'permissions'].includes(args[0] ?? '')) {
  await import('./eigos-administration.js');
} else if (args[0] === 'rollback') {
  const targetRelease = args[1];
  if (!targetRelease) throw new Error('Provide the retired release digest to roll back to');
  const installation = await selectedInstallation();
  const { db, metadata } = openInstallation(installation);
  const publisher = { owner: process.env.EIGOS_PUBLISHER_SUBJECT ?? 'deployment', scopes: [] };
  try {
    const access = await Access.load(db, publisher);
    const bindings = installation.assemble(db);
    let transform: ProjectionTransform | undefined;
    if (args[2]) {
      if (!isAbsolute(args[2])) throw new Error('Use an absolute source transformation module path');
      const module = await import(pathToFileURL(args[2]).href);
      if (typeof module.project !== 'function') throw new Error('Transformation module must export project(ref, properties)');
      transform = module.project as ProjectionTransform;
    }
    const published = await metadata.rollback(targetRelease, bindings, access, transform ? { transform } : undefined);
    await installation.afterActivation?.(db, published);
    console.log(JSON.stringify({
      release: published.release,
      definition: published.digest,
      projection: published.projection,
      runtime: published.runtimeId,
      rolledBackTo: targetRelease,
    }));
  } finally {
    await db.close();
  }
} else {
  await manageInstallation(await selectedInstallation(), args);
}
