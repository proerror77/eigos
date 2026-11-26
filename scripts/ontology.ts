import { loadExtensions } from '../packages/runtime/extensions.js';
import { readFile } from 'node:fs/promises';
import { businessDefinition } from '../packages/ontology/definition.js';
import { didiPAAccountResources, didiPAOrderAccountResources } from '../packages/ontology/didi-pa-access.js';
import { Ontology } from '../packages/ontology/model.js';
import { Database } from '../packages/runtime/database.js';
import { Metadata } from '../packages/runtime/metadata.js';
import { objectPolicySchema } from '../packages/runtime/security.js';
import { Access, setGrants, businessGrants, syncAccountGrants, syncAccountGrantsAfterActivation, grantSchema } from '../packages/runtime/access.js';
import { upgradePublicationStorage } from '../packages/runtime/upgrade.js';
import { createCapabilities } from '../packages/capabilities/index.js';
import { configuredSource } from '../packages/core/config.js';
import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProjectionTransform } from '../packages/runtime/metadata.js';
import { modelClearanceSchema, setModelClearance } from '../packages/runtime/model-egress.js';
import { enablePgvector } from '../packages/runtime/semantic-pgvector.js';
import { Accounts, accountActionsGroup } from '../packages/runtime/accounts.js';
import { installOwnerIsolation } from '../packages/runtime/owner-isolation.js';
import { provisionPublicPlaceCatalogue } from '../packages/capabilities/public-places/catalogue.js';
import { publicPlacesOntology } from '../packages/ontology/public-places.js';
import { ontologyName } from '../packages/ontology/schema.js';
import { accountCommand } from './account-command.js';
import { amapRideAccountResources } from '../packages/ontology/amap-ride.js';
import { amapObservationAccountResources } from '../packages/ontology/amap-observations.js';

const command = process.argv[2];
const document = businessDefinition;
const model = new Ontology(document);
const signupMode = () => z.enum(['open', 'invite', 'closed']).default('invite').parse(process.env.EIGOS_SIGNUP);
if (command === 'check') console.log(JSON.stringify({ id: model.document.id, version: model.document.version, digest: model.digest, objects: model.objects.size, interfaces: model.interfaces.size, links: model.links.size, actions: model.actions.size, functions: model.functions.size }));
else {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const db = new Database(process.env.DATABASE_URL, process.env.EIGOS_PG_SCHEMA), metadata = new Metadata(db);
  const publisher = { owner: process.env.EIGOS_PUBLISHER_SUBJECT ?? 'deployment', scopes: [] };
  try {
    if (command === 'initialize' || command === 'upgrade') {
      if (command === 'upgrade') await upgradePublicationStorage(db); else await db.initialize();
      await setGrants(db, publisher.owner, [{ resource: model.document.id, permission: 'manage_definition' }]);
    } else if (command === 'enable-owner-isolation') {
      console.log(JSON.stringify(await installOwnerIsolation(db)));
    } else if (command === 'enable-pgvector') {
      console.log(JSON.stringify(await enablePgvector(db)));
    } else if (command === 'invite') {
      const target = z.union([z.email(), z.string().regex(/^[a-f0-9]{64}$/)]).parse(process.argv[3]);
      const hours = z.coerce.number().int().min(1).max(168).parse(process.argv[4] ?? 48);
      console.log(await new Accounts(db, signupMode()).invite(target, hours));
    } else if (command === 'account') {
      const args = process.argv.slice(3);
      if (args[0] === 'approve-waitlist') {
        const owner = z.string().regex(/^[a-f0-9]{64}$/).parse(args[1]);
        const email = z.email().parse(args[2]);
        const approved = await new Accounts(db, signupMode()).approveApplication(owner, email);
        if (!approved) throw new Error('No matching eligible waitlist application');
        console.log(JSON.stringify({ approved }));
      } else if (args[0] === 'grant-amap-observations') {
        const active = await metadata.active('Eigos');
        const grants = businessGrants(active).filter(grant => amapObservationAccountResources.has(grant.resource));
        if (grants.length !== amapObservationAccountResources.size) throw new Error('The published Amap Action contract is incomplete');
        await db.query(`INSERT INTO ${db.schema}.resource_grants(subject,resource,permission)
          SELECT $1,resource,permission FROM jsonb_to_recordset($2::jsonb) AS g(resource text,permission text)
          ON CONFLICT DO NOTHING`, ['group:' + accountActionsGroup, JSON.stringify(grants)]);
        console.log(JSON.stringify({ release: active.release, grants: grants.length }));
      } else if (args[0] === 'applications') {
        const offset = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(args[1] ?? 0);
        console.log(JSON.stringify(await new Accounts(db, signupMode()).applications(offset)));
      } else if (args[0] === 'sync-beta-grants' || args[0] === 'grant-restaurant-search') {
        const active = await metadata.active('Eigos');
        await syncAccountGrants(db, active);
        console.log(JSON.stringify({ release: active.release }));
      } else if (args[0] === 'grant-didi-pa' || args[0] === 'grant-didi-pa-orders' || args[0] === 'grant-amap-ride') {
        const active = await metadata.active('Eigos');
        const amap = args[0] === 'grant-amap-ride';
        const resources = amap ? amapRideAccountResources
          : args[0] === 'grant-didi-pa-orders' ? didiPAOrderAccountResources : didiPAAccountResources;
        const grants = businessGrants(active).filter(grant => resources.has(grant.resource));
        if (grants.length !== resources.size) throw new Error('The published ride contract is incomplete');
        if (amap && !args[1]) throw new Error('Provide the approved Amap rider account');
        let subject = 'group:' + accountActionsGroup;
        if (args[1]) {
          const account = await new Accounts(db, signupMode()).find(z.union([z.email(), z.string().regex(/^[a-f0-9]{64}$/)]).parse(args[1]));
          if (account?.status !== 'active') throw new Error('An active Beta account is required');
          subject = 'account-actions:' + account.owner;
        }
        await db.query(`INSERT INTO ${db.schema}.resource_grants(subject,resource,permission)
          SELECT $1,resource,permission FROM jsonb_to_recordset($2::jsonb) AS g(resource text,permission text)
          ON CONFLICT DO NOTHING`, [subject, JSON.stringify(grants)]);
        console.log(JSON.stringify({ release: active.release, grants: grants.length }));
      } else console.log(JSON.stringify(await accountCommand(db, signupMode(), args)));
    } else if (command === 'provision-public-places') {
      const project = ontologyName.parse(process.argv[3]);
      await db.query(`INSERT INTO ${db.schema}.resource_grants(subject,resource,permission) VALUES($1,$2,'manage_definition')
        ON CONFLICT DO NOTHING`, [publisher.owner, publicPlacesOntology]);
      const access = await Access.load(db, publisher);
      const bindings = createCapabilities(db, configuredSource(process.env.EIGOS_DIDI_CONNECTION_FILE),
        await loadExtensions(process.env.EIGOS_EXTENSION_MODULE));
      console.log(JSON.stringify(await provisionPublicPlaceCatalogue(db, metadata, bindings, access, project)));
    } else if (command === 'replay-check') {
      // Read-only: whether the commit log explains the active projection's rows. Owners and ids are hashed unless
      // --show-identifiers is given; --owner checks one owner in its context, which owner isolation requires.
      const flag = (name: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
      const owner = flag('owner'), show = process.argv.includes('--show-identifiers');
      const { replayCheck } = await import('../packages/runtime/replay-check.js');
      const { createHash } = await import('node:crypto');
      const projection = (await metadata.active()).projection;
      const result = owner ? await db.withOwner(owner, () => replayCheck(db, projection)) : await replayCheck(db, projection);
      const hide = (value: string) => show ? value : createHash('sha256').update(value).digest('hex').slice(0, 12);
      console.log(JSON.stringify({ ...result, types: result.types.map(entry => ({ ...entry, owner: hide(entry.owner) })),
        links: result.links.map(entry => ({ ...entry, owner: hide(entry.owner) })),
        differences: result.differences.map(entry => ({ ...entry, owner: hide(entry.owner), id: hide(entry.id) })) }));
      if (!result.consistent) process.exitCode = 1;
    } else if (command === 'grant-business') {
      const owner = process.argv[3]; if (!owner) throw new Error('Provide the verified owner');
      await setGrants(db, owner, businessGrants(model, db.sandboxEnabled));
    } else if (command === 'permissions') {
      const config = z.strictObject({ subjects: z.array(z.strictObject({ owner: z.string().min(1), grants: z.array(grantSchema) })), properties: z.array(z.strictObject({ ontology: z.string(), type: z.string(), property: z.string() })).optional(), policies: z.array(z.strictObject({ type:z.string(),policy:objectPolicySchema })).optional(), memberships:z.array(z.strictObject({subject:z.string(),groups:z.array(z.string()),markings:z.array(z.string())})).optional(), modelClearances:z.array(modelClearanceSchema).optional() }).parse(JSON.parse(await readFile(process.argv[3]!, 'utf8')));
      for (const property of config.properties ?? []) if (property.ontology !== model.document.id || !model.object(property.type).properties[property.property]) throw new Error('Unknown protected property');
      for (const item of config.policies ?? []) {
        const type = model.object(item.type);
        if (item.policy.properties[type.primaryKey]) throw new Error('Primary key cannot have a property policy');
        const expressions = [item.policy.read,...Object.values(item.policy.properties)];
        const fields = [...Object.keys(item.policy.properties),...expressions.flatMap(e=>e?[...e.all,...e.any].map(c=>c.property):[]),...(item.policy.markingsProperty?[item.policy.markingsProperty]:[])];
        if (fields.some(field=>!type.properties[field])) throw new Error('Unknown security policy property');
        const controls=[...expressions.flatMap(e=>e?[...e.all,...e.any].map(c=>c.property):[]),...(item.policy.markingsProperty?[item.policy.markingsProperty]:[])];
        if(controls.some(field=>type.properties[field]?.derived))throw new Error('Security controls require stored properties');
      }
      await db.transaction(async client => {
        for (const item of config.policies ?? []) await db.query(`INSERT INTO ${db.schema}.object_policies VALUES($1,$2,$3) ON CONFLICT(ontology,type) DO UPDATE SET policy=excluded.policy`,[model.document.id,item.type,item.policy],client);
        for (const membership of config.memberships ?? []) {
          await db.query(`DELETE FROM ${db.schema}.security_memberships WHERE subject=$1`,[membership.subject],client);
          for (const [kind,names] of [['group',membership.groups],['marking',membership.markings]] as const) for (const name of names) await db.query(`INSERT INTO ${db.schema}.security_memberships VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[membership.subject,kind,name],client);
        }
        for (const clearance of config.modelClearances ?? []) await setModelClearance(db, clearance, client);
        for (const subject of config.subjects) await setGrants(db, subject.owner, subject.grants, client);
        if (config.properties) {
          await db.query(`DELETE FROM ${db.schema}.property_security`, [], client);
          for (const property of config.properties) await db.query(`INSERT INTO ${db.schema}.property_security(ontology,type,property) VALUES($1,$2,$3)`, [property.ontology, property.type, property.property], client);
        }
      });
    } else {
      const access = await Access.load(db, publisher), bindings = createCapabilities(db, configuredSource(process.env.EIGOS_DIDI_CONNECTION_FILE),await loadExtensions(process.env.EIGOS_EXTENSION_MODULE));
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
      if (!published) throw new Error('Use check, initialize, upgrade, enable-owner-isolation, enable-pgvector, permissions, invite, account, grant-business, provision-public-places, prepare, activate or publish');
      if (command === 'activate' || command === 'publish') await syncAccountGrantsAfterActivation(db, published);
      console.log(JSON.stringify({ release: published.release, definition: published.digest, projection: published.projection, runtime: published.runtimeId }));
    }
  } finally { await db.close(); }
}
