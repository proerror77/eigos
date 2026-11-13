import { readFile } from 'node:fs/promises';
import { Ontology } from '../packages/ontology/model.js';
import { Database } from '../packages/runtime/database.js';
import { Metadata } from '../packages/runtime/metadata.js';
import { Access, setGrants, memberGrants, grantSchema } from '../packages/runtime/access.js';
import { upgradePublicationStorage } from '../packages/runtime/upgrade.js';
import { rideCapabilities } from '../packages/capabilities/didi/pipeline.js';
import { configuredSource } from '../packages/core/config.js';
import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProjectionTransform } from '../packages/runtime/metadata.js';

const command = process.argv[2];
const document = JSON.parse(await readFile(new URL('../packages/ontology/definitions/ride.json', import.meta.url), 'utf8'));
const model = new Ontology(document);
if (command === 'check') console.log(JSON.stringify({ id: model.document.id, version: model.document.version, digest: model.digest, objects: model.objects.size, interfaces: model.interfaces.size, links: model.links.size, actions: model.actions.size, functions: model.functions.size }));
else {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const db = new Database(process.env.DATABASE_URL, process.env.EIGOS_PG_SCHEMA), metadata = new Metadata(db);
  const publisher = { owner: process.env.EIGOS_PUBLISHER_SUBJECT ?? 'deployment', scopes: [] };
  try {
    if (command === 'initialize' || command === 'upgrade') {
      if (command === 'upgrade') await upgradePublicationStorage(db); else await db.initialize();
      await setGrants(db, publisher.owner, [{ resource: model.document.id, permission: 'manage_definition' }]);
    } else if (command === 'grant-member') {
      const owner = process.argv[3]; if (!owner) throw new Error('Provide the verified member owner');
      await setGrants(db, owner, memberGrants(model));
    } else if (command === 'permissions') {
      const config = z.strictObject({ subjects: z.array(z.strictObject({ owner: z.string().min(1), grants: z.array(grantSchema) })), properties: z.array(z.strictObject({ ontology: z.string(), type: z.string(), property: z.string() })).optional() }).parse(JSON.parse(await readFile(process.argv[3]!, 'utf8')));
      for (const property of config.properties ?? []) if (property.ontology !== model.document.id || !model.object(property.type).properties[property.property]) throw new Error('Unknown protected property');
      await db.transaction(async client => {
        for (const subject of config.subjects) await setGrants(db, subject.owner, subject.grants, client);
        if (config.properties) {
          await db.query(`DELETE FROM ${db.schema}.property_security`, [], client);
          for (const property of config.properties) await db.query(`INSERT INTO ${db.schema}.property_security(ontology,type,property) VALUES($1,$2,$3)`, [property.ontology, property.type, property.property], client);
        }
      });
    } else {
      const access = await Access.load(db, publisher), bindings = rideCapabilities(db, configuredSource(process.env.EIGOS_DIDI_CONNECTION_FILE));
      let transform: ProjectionTransform | undefined;
      if ((command === 'prepare' || command === 'publish') && process.argv[3]) {
        if (!isAbsolute(process.argv[3])) throw new Error('Use an absolute source transformation module path');
        const module = await import(pathToFileURL(process.argv[3]).href);
        if (typeof module.project !== 'function') throw new Error('Transformation module must export project(ref, properties)');
        transform = module.project as ProjectionTransform;
      }
      const published = command === 'prepare' ? await metadata.prepare(document, bindings, access, transform)
        : command === 'activate' ? await metadata.activate(process.argv[3]!, bindings, access)
        : command === 'publish' ? await metadata.publish(document, bindings, access, transform) : undefined;
      if (!published) throw new Error('Use check, initialize, upgrade, permissions, grant-member, prepare, activate or publish');
      console.log(JSON.stringify({ release: published.release, definition: published.digest, projection: published.projection, runtime: published.runtimeId }));
    }
  } finally { await db.close(); }
}
