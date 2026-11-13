import { Conflict, digest } from '../core/identity.js';
import type { Ontology } from '../ontology/model.js';
import { valueKinds } from '../ontology/property-path.js';
import type { Database, Sql } from './database.js';
import { setExpressionSchema, type SetExpression } from './object-sets.js';
import { queryFields, querySchema } from './objects.js';

type SavedSet = { id: string; owner: string; mode: 'static' | 'dynamic'; expression: unknown; readers: string[] };

function contract(model: Ontology, root: SavedSet, sets: ReadonlyMap<string, SavedSet>) {
  const fields = new Map<string, string>();
  const mappings = new Map<string, string | undefined>();
  const links = new Map<string, string>();
  const dependencies = new Set<string>();
  let operations = 0;

  function follow(type: string, link: string, as?: string) {
    if (as && !model.interfaces.has(as)) throw new Error('Unknown Interface ' + as);
    const nav = model.navigation(type, link, as);
    links.set([type, as, link].join('.'), digest(nav));
    return nav.target;
  }

  function types(node: SetExpression, ancestors: ReadonlySet<string>, depth: number): Set<string> {
    if (++operations > 25000 || depth > 16) throw new Error('Object set definition exceeds its limits');
    const visit = (child: SetExpression) => types(child, ancestors, depth + 1);
    switch (node.op) {
      case 'query': {
        const result = model.concreteTypes(node.query.type);
        if (model.objects.has(node.query.type)) dependencies.add(node.query.type);
        const from = node.query.from;
        const target = from && follow(from.object.type, from.link, from.as);
        const selected = target ? result.filter(type => type === target) : result;
        for (const field of queryFields(querySchema.parse(node.query))) {
          const kinds = valueKinds(model.propertyPath(node.query.type, field)).filter(kind => kind !== 'null');
          fields.set(node.query.type + '.' + field, digest([...new Set(kinds.map(kind => kind === 'integer' ? 'number' : kind))]));
          const property = field.split('.')[0]!;
          for (const type of selected) {
            const local = model.propertyName(type, node.query.type, property);
            mappings.set(type + ':' + node.query.type + '.' + property, local);
          }
        }
        return new Set(selected);
      }
      case 'refs': {
        const selected = node.objects.filter(ref => model.objects.has(ref.type)).map(ref => ref.type);
        for (const type of selected) dependencies.add(type);
        return new Set(selected);
      }
      case 'saved': {
        const dependency = sets.get(node.id);
        if (!dependency || dependency.owner !== root.owner && !dependency.readers.includes(root.owner))
          throw new Error('Referenced object set is unavailable');
        if (ancestors.has(node.id)) throw new Error('Object set references form a cycle');
        return types(setExpressionSchema.parse(dependency.expression), new Set([...ancestors, node.id]), depth + 1);
      }
      case 'traverse': {
        let current = visit(node.set);
        for (const step of node.path) current = new Set([...current].map(type => follow(type, step.link, step.as)));
        return current;
      }
      case 'union':
        return new Set(node.sets.flatMap(child => [...visit(child)]));
      case 'intersection': {
        const [first, ...others] = node.sets.map(visit);
        return new Set([...first!].filter(type => others.every(child => child.has(type))));
      }
      case 'difference': {
        const left = visit(node.left);
        visit(node.right);
        // Two sets of the same type may have different members.
        return left;
      }
    }
  }

  types(setExpressionSchema.parse(root.expression), new Set([root.id]), 0);
  return { fields, mappings, links, dependencies };
}

/** Compare saved definitions without reading any owner's business data. */
export async function checkSavedObjectSets(db: Database, client: Sql, current: Ontology, candidate: Ontology) {
  if (current.digest === candidate.digest) return;
  const rows = (await db.query<SavedSet>(`SELECT id,owner,mode,expression,readers FROM ${db.schema}.object_sets WHERE ontology=$1 ORDER BY id`, [current.document.id], client)).rows;
  const sets = new Map(rows.map(row => [row.id, row]));
  let affected = 0;
  let firstIssue = '';
  for (const row of rows) {
    if (row.mode !== 'dynamic') continue;
    let before: ReturnType<typeof contract>;
    try { before = contract(current, row, sets); }
    catch { continue; } // A pre-existing broken dependency must not block unrelated publications.
    try {
      const after = contract(candidate, row, sets);
      for (const [field, shape] of before.fields) {
        if (after.fields.get(field) !== shape) throw new Error('Property type changed: ' + field);
      }
      for (const [field, local] of before.mappings) {
        if (after.mappings.has(field) && after.mappings.get(field) !== local)
          throw new Error('Interface property mapping changed: ' + field);
      }
      for (const [link, shape] of before.links) {
        if (after.links.get(link) !== shape) throw new Error('Link contract changed: ' + link);
      }
      for (const type of before.dependencies) {
        if (!candidate.objects.has(type)) throw new Error('Object Type removed: ' + type);
      }
    } catch (error) {
      affected++;
      firstIssue ||= (error as Error).message;
    }
  }
  if (affected) throw new Conflict(`Publication would break ${affected} saved dynamic object set(s). Update or remove the affected sets before publishing. ${firstIssue}`);
}
