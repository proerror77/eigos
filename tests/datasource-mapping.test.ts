import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInterfaceContractDefinition } from '../packages/ontology/seed-definition.js';
import { DATASOURCE_MAPPINGS, DIDI_PLACE_MAPPING, checkMapping, resolveProperties } from '../packages/ontology/datasource-mapping.js';

/** A payload shaped exactly like the didi `maps_textsearch` result, not like our object. */
const didiPlace = {
  id: 'a'.repeat(64),
  name: '上海站',
  address: '上海市静安区秣陵路303号',
  addressAll: '上海市静安区秣陵路303号（南广场）',
  city: '上海',
  lng: 121.4555,
  lat: 31.2492,
  coordinateSystem: 'provider_unspecified',
  identityKind: 'local_snapshot_digest',
};

const document: any = createInterfaceContractDefinition().document;
const declared = (type: string) => Object.keys(document.objects.find((value: any) => value.id === type).properties);

test('every property a mapped object declares is either filled or recorded as unavailable', () => {
  for (const mapping of DATASOURCE_MAPPINGS) {
    assert.deepEqual(checkMapping(mapping, declared(mapping.objectType)), [], `${mapping.service} -> ${mapping.objectType}`);
  }
});

test('a provider payload fills the object properties through the mapping, not by field name luck', () => {
  const properties = resolveProperties(DIDI_PLACE_MAPPING, didiPlace);
  assert.equal(properties.placeId, didiPlace.id);
  assert.equal(properties.name, '上海站', 'the business name comes from the provider name field');
  assert.equal(properties.displayTitle, '上海站');
  assert.equal(properties.address, didiPlace.address);
  assert.deepEqual(properties.coordinates, { lat: 31.2492, lng: 121.4555 }, 'a nested property maps from two fields');
  assert.equal(properties.coordinateUnit, 'degree', 'a constant is declared as a constant, not left to the reader');
});

test('a coordinate frame the provider cannot state is reported, never invented', () => {
  const properties = resolveProperties(DIDI_PLACE_MAPPING, didiPlace);
  assert.equal(Object.hasOwn(properties, 'coordinateSystem'), false, 'the provider said provider_unspecified, so we do not claim a frame');
  const recorded = (DIDI_PLACE_MAPPING.unmapped ?? []).find(entry => entry.property === 'coordinateSystem');
  assert.ok(recorded, 'the gap is recorded with its reason');
  assert.match(recorded!.reason, /provider_unspecified/);
});

test('a mapping that names a property the object does not declare is rejected', () => {
  const problems = checkMapping({ ...DIDI_PLACE_MAPPING, properties: { ...DIDI_PLACE_MAPPING.properties, notAProperty: 'id' } }, declared('Place'));
  assert.deepEqual(problems, ['unknown property: notAProperty']);
});

test('a property left neither mapped nor explained is rejected', () => {
  const { coordinateUnit: _dropped, ...rest } = DIDI_PLACE_MAPPING.properties;
  const problems = checkMapping({ ...DIDI_PLACE_MAPPING, properties: rest }, declared('Place'));
  assert.deepEqual(problems, ['unaccounted property: coordinateUnit']);
});

test('a payload missing a mapped field fails loudly instead of writing an object with a hole', () => {
  const { name: _missing, ...partial } = didiPlace;
  assert.throws(() => resolveProperties(DIDI_PLACE_MAPPING, partial), /has no field name/);
});
