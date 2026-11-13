import type { validator, Ontology } from './model.js';
import { valueKinds } from './property-path.js';
import type { DerivedExpression } from './schema.js';

/** Check concrete references and expression types before a definition can be published. */
export function validateDerivedProperties(model: Ontology, validate: typeof validator) {
  const depths = new Map<string, number>();
  const visiting = new Set<string>();

  function property(type: string, path: string) {
    const schema = model.propertyPath(type, path);
    const name = path.split('.')[0]!;
    const depth = definition(type, name);
    return { kinds: valueKinds(schema).filter(kind => kind !== 'null'), depth };
  }

  function numeric(kinds: string[]) {
    if (!kinds.length || kinds.some(kind => kind !== 'integer' && kind !== 'number'))
      throw new Error('Numeric expression requires numeric properties');
  }

  function expression(type: string, node: DerivedExpression, depth = 0): { kinds: string[]; depth: number } {
    if (depth > 16) throw new Error('Expression exceeds its depth limit');
    if (node.op === 'literal') return { kinds: [Number.isInteger(node.value) ? 'integer' : 'number'], depth: 0 };
    if (node.op === 'property') return property(type, node.property);
    if (node.op === 'linked') {
      let target = type;
      for (const step of node.path) {
        if (step.as && !model.interfaces.has(step.as)) throw new Error('Unknown Interface ' + step.as);
        const navigation = model.navigation(target, step.link, step.as);
        if (node.aggregate === 'select' && navigation.cardinality !== 'one')
          throw new Error('Linked select requires a to-one path');
        target = navigation.target;
      }
      if (node.aggregate === 'count') return { kinds: ['integer'], depth: 0 };
      if (!node.property) throw new Error('Linked value aggregation requires a property');
      const result = property(target, node.property);
      if (node.aggregate === 'select') return result;
      numeric(result.kinds);
      return node.aggregate === 'avg' ? { ...result, kinds: ['integer', 'number'] } : result;
    }
    const left = expression(type, node.left, depth + 1), right = expression(type, node.right, depth + 1);
    numeric(left.kinds);
    numeric(right.kinds);
    const integer = node.op !== 'divide' && [...left.kinds, ...right.kinds].every(kind => kind === 'integer');
    return { kinds: integer ? ['integer'] : ['integer', 'number'], depth: Math.max(left.depth, right.depth) };
  }

  function definition(type: string, name: string): number {
    const field = model.object(type).properties[name]!;
    if (!field.derived) return 0;
    const key = type + '.' + name;
    const known = depths.get(key);
    if (known !== undefined) return known;
    if (visiting.has(key)) throw new Error('Dependency cycle at ' + key);
    if (visiting.size >= 16) throw new Error('Dependency chain exceeds its depth limit');
    visiting.add(key);
    try {
      const result = expression(type, field.derived);
      const accepted = valueKinds(field.schema);
      if (!result.kinds.length || result.kinds.some(kind => !accepted.includes(kind)))
        throw new Error('Expression result is incompatible with its declared value type');
      if (field.derived.op === 'literal' && !validate(field.schema).safeParse(field.derived.value).success)
        throw new Error('Literal violates its declared value constraints');
      const depth = 1 + result.depth;
      if (depth > 16) throw new Error('Dependency chain exceeds its depth limit');
      depths.set(key, depth);
      return depth;
    } finally { visiting.delete(key); }
  }

  for (const [type, object] of model.objects) {
    for (const name of Object.keys(object.properties)) {
      try { definition(type, name); }
      catch (error) {
        throw new Error('Invalid derived property ' + type + '.' + name + ': ' + (error as Error).message);
      }
    }
  }
}
