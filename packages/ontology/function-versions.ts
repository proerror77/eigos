import { digest } from '../core/identity.js';
import { semanticVersion, versionRange, type OntologyDocument } from './schema.js';
export { versionRange };

/**
 * Versions of published Functions, after Palantir's function versioning: a publisher chooses each version, a released
 * version is immutable, and a backward incompatible change needs a new major version. Consumers accept a pinned
 * version or a range of backward compatible versions.
 */
type FunctionType = OntologyDocument['functionTypes'][number];
type Version = readonly [number, number, number];

export function parseVersion(version: string | undefined): Version | undefined {
  if (!version || !semanticVersion.test(version)) return undefined;
  return version.split('.').map(Number) as unknown as Version;
}

export function compareVersions(a: Version, b: Version) {
  for (const index of [0, 1, 2] as const) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

/**
 * Whether `version` lies in `range`. Below 1.0.0 the minor version is the major one, as in npm: `^0.2.3` accepts 0.2.x
 * from 0.2.3, and `^0.0.3` only 0.0.3.
 */
export function satisfies(version: string | undefined, range: string) {
  const actual = parseVersion(version), operator = range.startsWith('^') || range.startsWith('~') ? range[0]! : '';
  const base = parseVersion(range.slice(operator.length));
  if (!actual || !base || compareVersions(actual, base) < 0) return false;
  if (!operator) return compareVersions(actual, base) === 0;
  if (operator === '~') return actual[0] === base[0] && actual[1] === base[1];
  if (base[0] > 0) return actual[0] === base[0];
  if (base[1] > 0) return actual[0] === 0 && actual[1] === base[1];
  return actual[0] === 0 && actual[1] === 0 && actual[2] === base[2];
}

const annotations = new Set(['description', 'title', 'examples', '$comment']);
/** A JSON Schema without its annotations, which do not change what it accepts. */
function essential(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(essential);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema).filter(([key]) => !annotations.has(key)).map(([key, value]) => [key, essential(value)]));
}
type ObjectSchema = { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown };
const same = (a: unknown, b: unknown) => digest(essential(a) ?? null) === digest(essential(b) ?? null);
const rest = ({ properties: _properties, required: _required, additionalProperties: _additional, ...other }: ObjectSchema & Record<string, unknown>) => other;

/**
 * Why `next` is not backward compatible with `previous`. Callers send inputs and read outputs, so a change is breaking
 * when an input is removed, changes, or becomes required, when inputs stop accepting other properties, or when an output
 * is removed, changes, or may be missing. Annotations are ignored. As Palantir notes, such checks cannot be exhaustive:
 * they find breaking changes, and a change they accept can still break a caller.
 */
export function breakingChanges(previous: FunctionType, next: FunctionType): string[] {
  const reasons: string[] = [];
  const before = previous.parameters as ObjectSchema & Record<string, unknown>, after = next.parameters as ObjectSchema & Record<string, unknown>;
  for (const [name, schema] of Object.entries(before.properties ?? {})) {
    if (!(name in (after.properties ?? {}))) reasons.push(`input ${name} was removed`);
    else if (!same(schema, after.properties![name])) reasons.push(`input ${name} changed`);
  }
  const wasRequired = new Set(before.required ?? []);
  for (const name of after.required ?? []) if (!wasRequired.has(name)) reasons.push(`input ${name} became required`);
  if (after.additionalProperties === false && before.additionalProperties !== false) reasons.push('inputs no longer accept other properties');
  else if (!same(before.additionalProperties, after.additionalProperties) && after.additionalProperties !== undefined && after.additionalProperties !== true)
    reasons.push('other inputs changed');
  if (!same(rest(before), rest(after))) reasons.push('the input schema changed');

  const output = (schema: Record<string, unknown>) => schema.type === 'object' && !('anyOf' in schema || 'oneOf' in schema) ? schema as ObjectSchema & Record<string, unknown> : undefined;
  const returnedBefore = output(previous.returns), returnedAfter = output(next.returns);
  if (returnedBefore && returnedAfter) {
    for (const [name, schema] of Object.entries(returnedBefore.properties ?? {})) {
      if (!(name in (returnedAfter.properties ?? {}))) reasons.push(`output ${name} was removed`);
      else if (!same(schema, returnedAfter.properties![name])) reasons.push(`output ${name} changed`);
    }
    const required = new Set(returnedAfter.required ?? []);
    for (const name of returnedBefore.required ?? []) if (!required.has(name)) reasons.push(`output ${name} may be missing`);
    if (!same(rest(returnedBefore), rest(returnedAfter))) reasons.push('the output schema changed');
  } else if (!same(previous.returns, next.returns)) reasons.push('the output changed');
  return reasons;
}

/**
 * Why `next` cannot be released as a new version after `previous`, the version the active release has, or undefined
 * when it can. Only semantic versions are compared. A changed Function needs a higher version, and a breaking change a
 * new major version; below 1.0.0, a new minor version.
 */
export function versionProblem(previous: FunctionType, next: FunctionType): string | undefined {
  const before = parseVersion(previous.version), after = parseVersion(next.version);
  if (!before || !after || digest(previous) === digest(next)) return undefined;
  if (compareVersions(after, before) <= 0) return `Release ${next.apiName} as a version above ${previous.version}`;
  const reasons = breakingChanges(previous, next);
  if (!reasons.length) return undefined;
  const major = before[0] === 0 ? after[0] > 0 || after[1] > before[1] : after[0] > before[0];
  if (major) return undefined;
  const required = before[0] === 0 ? `0.${before[1] + 1}.0` : `${before[0] + 1}.0.0`;
  return `${next.apiName} ${next.version} is not backward compatible with ${previous.version} (${reasons.join('; ')}): release it as ${required} or later`;
}
