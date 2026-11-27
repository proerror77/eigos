import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openInstallation } from '../packages/runtime/open-installation.js';
import type { Installation } from '../packages/runtime/installation.js';
import { Access, businessGrants, setGrants } from '../packages/runtime/access.js';
import { installOwnerIsolation } from '../packages/runtime/owner-isolation.js';
import { upgradePublicationStorage } from '../packages/runtime/upgrade.js';
import type { ProjectionTransform } from '../packages/runtime/metadata.js';

export async function manageInstallation(installation: Installation, [command, argument]: string[]) {
  if (command === 'check' || command === 'export') {
    const { model } = installation;
    if (command === 'export') {
      if (!argument) throw new Error('Provide the path for the exported definition package');
      await writeFile(argument, JSON.stringify({ format: 'eigos-ontology-package-v1', ontology: model.document.id,
        version: model.document.version, digest: model.digest, document: model.document }) + '\n');
    } else console.log(JSON.stringify({ id: model.document.id, version: model.document.version, digest: model.digest,
      objects: model.objects.size, interfaces: model.interfaces.size, links: model.links.size, actions: model.actions.size, functions: model.functions.size }));
  } else if (['initialize', 'upgrade', 'enable-owner-isolation', 'grant-business', 'prepare', 'publish', 'activate'].includes(command ?? '')) {
    const { db, metadata } = openInstallation(installation);
    const { model } = installation;
    const publisher = { owner: process.env.EIGOS_PUBLISHER_SUBJECT ?? 'deployment', scopes: [] };
    try {
      if (command === 'initialize' || command === 'upgrade') {
        if (command === 'upgrade') { await upgradePublicationStorage(db); await installation.upgradeData?.(db,installation.model); }
        else await db.initialize();
        await setGrants(db, publisher.owner, [{ resource: model.document.id, permission: 'manage_definition' }]);
      } else if (command === 'enable-owner-isolation') {
        console.log(JSON.stringify(await installOwnerIsolation(db)));
      } else if (command === 'grant-business') {
        if (!argument) throw new Error('Provide the verified owner');
        await setGrants(db, argument, businessGrants(model, db.sandboxEnabled));
      } else {
        const access = await Access.load(db, publisher), bindings = installation.assemble(db);
        let transform: ProjectionTransform | undefined;
        if (command !== 'activate' && argument) {
          if (!isAbsolute(argument)) throw new Error('Use an absolute source transformation module path');
          transform = (await import(pathToFileURL(argument).href)).project;
          if (typeof transform !== 'function') throw new Error('Transformation module must export project(ref, properties)');
        }
        if (command === 'activate' && (!argument || (await metadata.get(argument)).document.id !== model.document.id))
          throw new Error('Select a candidate from this installation');
        const published = command === 'activate' ? await metadata.activate(argument!, bindings, access)
          : command === 'prepare' ? await metadata.prepare(model.document, bindings, access, transform)
          : await metadata.publish(model.document, bindings, access, transform);
        if (command !== 'prepare') await installation.afterActivation?.(db, published);
        console.log(JSON.stringify({ release: published.release, definition: published.digest, projection: published.projection, runtime: published.runtimeId }));
      }
    } finally { await db.close(); }
  } else throw new Error('Unsupported installation command: ' + command);
}
