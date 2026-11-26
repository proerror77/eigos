import assert from 'node:assert/strict';
import { test } from 'node:test';
import { breakingChanges, satisfies, versionProblem } from '../packages/ontology/function-versions.js';
import { Ontology } from '../packages/ontology/model.js';
import type { OntologyDocument } from '../packages/ontology/schema.js';
import { document } from './fixture.js';

type FunctionType = OntologyDocument['functionTypes'][number];
const text = { type: 'string' }, number = { type: 'number' };
const fn = (version: string, parameters: Record<string, unknown>, returns: Record<string, unknown> = { type: 'object', properties: { total: number }, required: ['total'] }): FunctionType =>
  ({ apiName: 'Quote', description: 'Quote a price', version, parameters, returns });
const inputs = (properties: Record<string, unknown>, required: string[] = [], extra: Record<string, unknown> = {}) =>
  ({ type: 'object', properties, required, ...extra });
const base = fn('1.0.0', inputs({ item: text, count: number }, ['item']));

test('version ranges accept a pinned version, later patches, or later versions until the next major', () => {
  const cases: [string, string, boolean][] = [
    ['1.2.3', '1.2.3', true], ['1.2.4', '1.2.3', false],
    ['1.2.9', '~1.2.3', true], ['1.3.0', '~1.2.3', false], ['1.2.2', '~1.2.3', false],
    ['1.9.0', '^1.2.3', true], ['2.0.0', '^1.2.3', false], ['1.2.2', '^1.2.3', false],
    // Below 1.0.0 the minor version is the major one.
    ['0.2.9', '^0.2.3', true], ['0.3.0', '^0.2.3', false], ['0.0.3', '^0.0.3', true], ['0.0.4', '^0.0.3', false],
    ['1', '^1.0.0', false], [undefined as unknown as string, '1.0.0', false],
  ];
  for (const [version, range, accepted] of cases) assert.equal(satisfies(version, range), accepted, `${version} in ${range}`);
});

test('breaking changes are those that can break a caller of the previous version', () => {
  const cases: [string, FunctionType, string[]][] = [
    ['an optional input added', fn('1.1.0', inputs({ item: text, count: number, note: text }, ['item'])), []],
    ['an output added', fn('1.1.0', base.parameters, { type: 'object', properties: { total: number, currency: text }, required: ['total'] }), []],
    ['an annotation changed', fn('1.0.1', inputs({ item: { type: 'string', description: 'The item' }, count: number }, ['item'])), []],
    ['a required input made optional', fn('1.1.0', inputs({ item: text, count: number })), []],
    ['an input removed', fn('1.1.0', inputs({ item: text }, ['item'])), ['input count was removed']],
    ['an input changed', fn('1.1.0', inputs({ item: number, count: number }, ['item'])), ['input item changed']],
    ['an input made required', fn('1.1.0', inputs({ item: text, count: number }, ['item', 'count'])), ['input count became required']],
    ['a new required input', fn('1.1.0', inputs({ item: text, count: number, store: text }, ['item', 'store'])), ['input store became required']],
    ['other inputs refused', fn('1.1.0', inputs({ item: text, count: number }, ['item'], { additionalProperties: false })), ['inputs no longer accept other properties']],
    ['an output removed', fn('1.1.0', base.parameters, { type: 'object', properties: {}, required: [] }), ['output total was removed', 'output total may be missing']],
    ['an output changed', fn('1.1.0', base.parameters, { type: 'object', properties: { total: text }, required: ['total'] }), ['output total changed']],
    ['an output made optional', fn('1.1.0', base.parameters, { type: 'object', properties: { total: number } }), ['output total may be missing']],
    ['the output type changed', fn('1.1.0', base.parameters, { type: 'array', items: number }), ['the output changed']],
  ];
  for (const [change, next, reasons] of cases) assert.deepEqual(breakingChanges(base, next), reasons, change);
});

test('a changed Function needs a higher version, and a breaking change a new major version', () => {
  const required = fn('1.1.0', inputs({ item: text, count: number }, ['item', 'count']));
  assert.equal(versionProblem(base, base), undefined);
  assert.equal(versionProblem(base, fn('1.0.1', inputs({ item: text, count: number, note: text }, ['item']))), undefined);
  assert.equal(versionProblem(base, fn('1.0.0', inputs({ item: text, count: number, note: text }, ['item']))), 'Release Quote as a version above 1.0.0');
  assert.equal(versionProblem(fn('1.2.0', base.parameters), fn('1.1.9', inputs({ item: text }))), 'Release Quote as a version above 1.2.0');
  assert.equal(versionProblem(base, required),
    'Quote 1.1.0 is not backward compatible with 1.0.0 (input count became required): release it as 2.0.0 or later');
  assert.equal(versionProblem(base, { ...required, version: '2.0.0' }), undefined);
  // Below 1.0.0 a breaking change needs a new minor version.
  const early = { ...base, version: '0.3.1' };
  assert.match(versionProblem(early, { ...required, version: '0.3.2' })!, /release it as 0\.4\.0 or later$/);
  assert.equal(versionProblem(early, { ...required, version: '0.4.0' }), undefined);
  assert.equal(versionProblem(early, { ...required, version: '1.0.0' }), undefined);
  // Versions that are not semantic are not compared.
  assert.equal(versionProblem({ ...base, version: '1' }, { ...required, version: '1' }), undefined);
});

test('an Action accepts only Functions whose version is in the range it names', () => {
  const definition = (range: string, version = '1.2.0') => {
    const copy = structuredClone(document);
    copy.functionTypes.push({ apiName: 'RouteAllowed', description: 'Whether a route may be renamed', version,
      parameters: { type: 'object' }, returns: { type: 'boolean' } });
    copy.actionTypes.push({
      apiName: 'RenameAllowedRoute', description: 'Rename a route that may be renamed',
      parameters: { type: 'object', properties: { route: { type: 'object' }, revision: { type: 'integer' } }, required: ['route', 'revision'] },
      objectParameters: { route: 'Route' },
      submissionCriteria: [{ function: 'RouteAllowed', functionVersion: range, arguments: {} }],
      rules: [{ op: 'editObject', object: { parameter: 'route' }, expectedRevision: { parameter: 'revision' }, properties: { name: { literal: 'Renamed' } } }],
      result: { type: 'Route', id: { parameter: 'route', path: ['id'] } },
    });
    return copy;
  };
  assert.ok(new Ontology(definition('^1.0.0')));
  assert.ok(new Ontology(definition('~1.2.0')));
  assert.throws(() => new Ontology(definition('^1.0.0', '2.0.0')), /RenameAllowedRoute accepts RouteAllowed \^1\.0\.0, but the ontology has 2\.0\.0/);
  assert.throws(() => new Ontology(definition('1.2.0', '1')), /but the ontology has 1$/);
  assert.throws(() => new Ontology(definition('>=1.0.0')), /functionVersion/);
});
