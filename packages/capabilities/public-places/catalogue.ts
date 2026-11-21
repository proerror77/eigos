import type { z } from 'zod';
import { Conflict, NotFound, PermissionDenied, digest } from '../../core/identity.js';
import { Ontology } from '../../ontology/model.js';
import {
  listPublicPlacesSchema,
  publicPlacesDefinition,
  publicPlacesOntology,
  publicPlaceType,
  publishPublicPlace,
  publishPublicPlaceSchema,
  revisePublicPlace,
  withdrawPublicPlace,
  withdrawPublicPlaceSchema,
} from '../../ontology/public-places.js';
import { ontologyName } from '../../ontology/schema.js';
import { Access, businessGrants, resource, setGrants } from '../../runtime/access.js';
import type { Actions } from '../../runtime/actions.js';
import type { Database, Sql } from '../../runtime/database.js';
import type { Bindings, Metadata } from '../../runtime/metadata.js';
import { Objects } from '../../runtime/objects.js';

const homeOntology = 'Eigos';
const model = new Ontology(publicPlacesDefinition);
const storageOwner = (project: string) => 'public-places:' + project;
const ref = (id: string) => ({ type: publicPlaceType, id });

async function requireProject(db: Database, project: string, client?: Sql) {
  const { rowCount } = await db.query(`SELECT 1 FROM ${db.schema}.ontology_projects WHERE ontology=$1 AND id=$2`,
    [homeOntology, project], client);
  if (!rowCount) throw new NotFound('Public place project is unavailable');
}

/** Share only fields supplied for publication, using a distinct graph partition for each project. */
export class PublicPlaceCatalogue {
  constructor(private readonly db: Database, private readonly metadata: Metadata, private readonly actions: Actions) {}

  private async authorize(access: Access, project: string, write: boolean, client?: Sql) {
    const target = resource(homeOntology, 'project', project);
    access.require(homeOntology, 'view_definition', target);
    access.require(homeOntology, 'view_objects', target, true);
    if (write) access.require(homeOntology, 'apply_action', target);
    await access.refresh(client);
    await requireProject(this.db, project, client);
  }
  private async active(client?: Sql) {
    const active = await this.metadata.active(publicPlacesOntology, client, Boolean(client));
    if (active.digest !== model.digest || active.runtimeId !== this.db.runtimeId)
      throw new Conflict('Public place catalogue requires its compatible publication');
    return active;
  }

  async list(access: Access, { project, id, city, cursor, limit, includeWithdrawn }: z.output<typeof listPublicPlacesSchema>) {
    await this.authorize(access, project, includeWithdrawn === true);
    const owner = storageOwner(project);
    return this.db.withOwner(owner, () => this.db.transaction(async client => {
      const publication = await this.active(client);
      const partition = await Access.load(this.db, { owner, scopes: [] }, client);
      const result = await new Objects(this.db, publication, partition, client).query({
        type: publicPlaceType,
        where: { ...(includeWithdrawn ? {} : { published: true }), ...(id ? { id } : {}), ...(city ? { city } : {}) },
        cursor, limit,
      });
      if (!(await partition.canReturn(partition.dataRequirements(), client)))
        throw new PermissionDenied('Public place permissions changed during execution');
      await this.authorize(access, project, includeWithdrawn === true, client);
      return result;
    }));
  }

  async publish(access: Access, { project, requestId, id, revision, ...place }: z.output<typeof publishPublicPlaceSchema>) {
    if (revision === undefined) return this.apply(access, project, requestId, publishPublicPlace, { id, ...place });
    return this.apply(access, project, requestId, revisePublicPlace, { place: ref(id), revision, ...place });
  }

  async withdraw(access: Access, { project, requestId, id, revision }: z.output<typeof withdrawPublicPlaceSchema>) {
    return this.apply(access, project, requestId, withdrawPublicPlace, { place: ref(id), revision });
  }

  private async apply(access: Access, project: string, requestId: string, action: string, input: Record<string, unknown>) {
    await this.authorize(access, project, true);
    const publication = await this.active();
    const owner = storageOwner(project), actor = access.principal.owner;
    return this.db.withOwner(owner, async () => {
      const partition = await Access.load(this.db, { owner, scopes: [] });
      return this.actions.apply(partition, publication, action, input, digest([actor, requestId]),
        client => this.authorize(access, project, true, client), undefined, undefined, { kind: 'client', id: actor });
    });
  }
}

/** Provision via the existing administrative database entry point. No personal records are selected or copied. */
export async function provisionPublicPlaceCatalogue(db: Database, metadata: Metadata, bindings: Bindings, publisher: Access, project: string) {
  ontologyName.parse(project);
  await publisher.refresh();
  publisher.require(publicPlacesOntology, 'manage_definition', publicPlacesOntology);
  await requireProject(db, project);
  const { rows: [record] } = await db.query<{ release: string }>(
    `SELECT release FROM ${db.schema}.ontology WHERE id=$1`, [publicPlacesOntology]);
  const current = record && await metadata.get(record.release);
  if (current && current.digest !== model.digest) throw new Conflict('An unrelated definition owns the public place Ontology');
  const publication = current?.runtimeId === db.runtimeId ? current : await metadata.publish(publicPlacesDefinition, bindings, publisher);
  await setGrants(db, storageOwner(project), businessGrants(publication));
  return { project, release: publication.release };
}
