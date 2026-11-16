import type { Ontology } from './model.js';
import { ontologyName, type OntologyDocument, type ObjectRef } from './schema.js';

const text = { type: 'string' };
const nullableText = { type: ['string', 'null'] };
const properties = Object.fromEntries(Object.entries({
  id: text, name: text, processId: text, property: text,
  oldState: nullableText, newState: nullableText,
  timestamp: { ...text, format: 'date-time' }, recordedAt: { ...text, format: 'date-time' },
  sequence: text, action: nullableText, requestId: nullableText, taskId: nullableText,
  source: nullableText, actor: text, release: text,
}).map(([name, schema]) => [name, { description: `Process log ${name}`, schema, required: true }]));

/** Log objects are read-only projections of the existing, committed edit history. */
export function addProcessLogs(document: OntologyDocument, tracked: { type: string; property: string }[]) {
  if (!document.interfaceTypes.some(type=>type.apiName==='ProcessLog')) document.interfaceTypes.push({ apiName: 'ProcessLog', description: 'Observed changes to an Ontology process state',
    properties, optionalProperties: [], links: {}, actions: {} });
  for (const { type, property } of tracked) {
    const object = document.objectTypes.find(item => item.apiName === type);
    const state = object?.properties[property]?.schema;
    if (!state || state.type!=='string' || !Array.isArray(state.enum) || !state.enum.every(value=>typeof value==='string'))
      throw new Error(`Process state requires an enumerable string: ${type}.${property}`);
    const log = ontologyName.parse(`${type}${property[0]!.toUpperCase()}${property.slice(1)}Log`);
    document.objectTypes.push({ apiName: log, displayName: `${object.displayName} process log`,
      description: `Committed changes to ${type}.${property}; proposed Scenario edits are excluded`,
      primaryKey: 'id', titleProperty: 'name', properties,
      typeClasses: [{ kind: 'machinery-log', name: type }, { kind: 'machinery-property', name: property }],
      interfaces: { ProcessLog: { properties: Object.fromEntries(Object.keys(properties).map(name => [name, name])), links: {}, actions: {} } } });
    document.linkTypes.push({ apiName: ontologyName.parse(`${log}Process`), description: `State changes of ${type}.${property}`,
      from: { type: log, name: 'process', cardinality: 'one' },
      to: { type, name: `${property}Logs`, cardinality: 'many' } });
  }
}

export function processLogTarget(model: Ontology, type: string) {
  const classes = model.objects.get(type)?.typeClasses;
  const objectType = classes?.find(item => item.kind === 'machinery-log')?.name;
  if (!objectType) return;
  const property = classes?.find(item => item.kind === 'machinery-property')?.name;
  const source = model.objects.get(objectType);
  const state = property && source?.properties[property]?.schema;
  if (!property || !state || state.type!=='string' || !Array.isArray(state.enum) || !state.enum.every(value=>typeof value==='string') || source?.typeClasses?.some(item => item.kind === 'machinery-log'))
    throw new Error('Process logs require a business object and state property');
  const navigation = model.navigation(type,'process');
  if (navigation.target!==objectType || navigation.cardinality!=='one') throw new Error('Process log requires its business-object relationship');
  return { type, objectType, property, link: navigation.link };
}

export type MachineryModel = NonNullable<OntologyDocument['objectTypes'][number]['machinery']>;
export type ProcessLogTarget = NonNullable<ReturnType<typeof processLogTarget>>;

export function validateMachineryModel(model: Ontology, type: ObjectRef['type'], specification: MachineryModel) {
  const target = processLogTarget(model, type);
  if (!target) throw new Error('Machinery models require a published ProcessLog type');
  const allowed = new Set(model.object(target.objectType).properties[target.property]!.schema.enum as string[]);
  const states = new Set(specification.states.map(state => state.name));
  if (states.size !== specification.states.length || [...states].some(state => !allowed.has(state)))
    throw new Error('Machinery states must be unique values of the tracked state property');
  const transitions = new Set<string>();
  for (const edge of specification.transitions) {
    const key = JSON.stringify([edge.from, edge.to]);
    if (edge.from === edge.to || (edge.from !== null && !states.has(edge.from))
        || (edge.to !== null && !states.has(edge.to)) || transitions.has(key))
      throw new Error('Machinery transitions require distinct known endpoints and must be unique');
    transitions.add(key);
    if (edge.action) model.action(edge.action);
  }
  const children = new Set<string>();
  for (const child of specification.subprocesses ?? []) {
    const navigation = model.navigation(target.objectType, child.link);
    if (children.has(child.link) || processLogTarget(model, child.process)?.objectType !== navigation.target)
      throw new Error('Machinery subprocesses require a unique link to a tracked business object');
    children.add(child.link);
  }
}
