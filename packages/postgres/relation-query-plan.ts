import { z } from 'zod';
import { DomainError } from '../core/domain.js';
import { objectRefSchema, type ObjectRef, type OntologyModel } from '../ontology/model.js';

export interface RelationNavigation {
  from: ObjectRef;
  linkId: string;
  side: 'from' | 'to';
  other: 'from' | 'to';
  target: string;
  endpointType: string;
  historical: boolean;
}
export interface ParameterizedRelationQuery { text: string; values: unknown[] }
const schemaName = z.string().regex(/^eigos_business_[a-z0-9_]{1,40}$/);
// The task inventory is a bounded candidate list, not yet an object read. Keep
// unrelated malformed identities out of the later authorization step instead
// of making their presence break a narrow relationship query.
const references = z.array(z.strictObject({ type: z.string(), id: z.string() })).max(2000);

/** Host-only plan metadata. Public callers still submit one existing ObjectQuery;
 * neither table/column names nor an arbitrary path enter through request JSON. */
export function relationNavigation(model: OntologyModel, from: ObjectRef, link: string, as?: string): RelationNavigation {
  const source = objectRefSchema.parse(from);
  if (as && (!model.isInterface(as) || !model.implements(source.type, as))) throw new DomainError('INVALID_INPUT', 'Object does not implement the requested interface');
  const navigation = model.navigation(source.type, link, as), side = navigation.direction === 'forward' ? 'from' : 'to';
  return { from: source, linkId: navigation.link.id, side, other: side === 'from' ? 'to' : 'from',
    target: navigation.viewType ?? navigation.other.type, endpointType: navigation.other.type, historical: model.linkWritePolicy(navigation.link.id) === 'source' };
}

/** Candidate identities only. The caller must authorize returned objects before
 * reading their values or using them as the next hop's source frontier. */
export function relationCandidateQuery(schema: string, ontologyId: string, owner: string,
  requested: readonly RelationNavigation[], candidates: readonly ObjectRef[]): ParameterizedRelationQuery {
  schemaName.parse(schema);
  if (!requested.length || requested.length > 50) throw new DomainError('INVALID_INPUT', 'Relationship frontier must contain between 1 and 50 sources');
  const selected = references.parse(candidates), scoped = ontologyId !== 'eigos.business';
  if (Buffer.byteLength(JSON.stringify(selected)) > 8388608) throw new DomainError('CONFLICT', 'Relationship candidates exceed their byte bound');
  const rows = requested.map(navigation => ({ ...navigation.from, link: navigation.linkId, forward: navigation.side === 'from' }));
  const values: unknown[] = [JSON.stringify(rows), JSON.stringify(selected), owner, ...(scoped ? [ontologyId] : [])];
  return { text: `WITH requested AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(type text,id text,link text,forward boolean)),
    candidates AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS c(type text,id text))
    SELECT DISTINCT c.type COLLATE "C" AS type,c.id COLLATE "C" AS id FROM candidates c WHERE EXISTS(
      SELECT 1 FROM requested r JOIN "${schema}".ontology_${scoped ? 'scoped_' : ''}links l ON l.owner=$3${scoped ? ' AND l.ontology_id=$4' : ''} AND l.type=r.link
        AND ((r.forward AND l.from_type=r.type AND l.from_id=r.id AND l.to_type=c.type AND l.to_id=c.id)
          OR (NOT r.forward AND l.to_type=r.type AND l.to_id=r.id AND l.from_type=c.type AND l.from_id=c.id)))
    ORDER BY type,id`, values };
}

/** Counts the physical relationship for completeness checks only. It does not
 * authorize its endpoints or disclose a count through a public query response. */
export function relationCountQuery(schema: string, ontologyId: string, owner: string, navigation: RelationNavigation): ParameterizedRelationQuery {
  schemaName.parse(schema);
  const scoped = ontologyId !== 'eigos.business';
  return { text: `SELECT count(*) AS n FROM "${schema}".ontology_${scoped ? 'scoped_' : ''}links
    WHERE owner=$1 AND type=$2 AND ${navigation.side}_type=$3 AND ${navigation.side}_id=$4${scoped ? ' AND ontology_id=$5' : ''}`,
  values: [owner, navigation.linkId, navigation.from.type, navigation.from.id, ...(scoped ? [ontologyId] : [])] };
}
