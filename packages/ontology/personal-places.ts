import { z } from 'zod';
import { type OntologyDocument } from './schema.js';
import type { Classification } from './classification.js';
import { json } from './service-contracts.js';

export const personalPlaceType = 'PersonalPlace';
export const personalPlaceVersionType = 'PersonalPlaceVersion';
export const personalPlaceHistoryLink = 'PersonalPlaceVersions';
export const currentPersonalPlaceVersionLink = 'PersonalPlaceCurrentVersion';
export const savePersonalPlace = 'SavePersonalPlace';
export const personalPlaceEdit = 'savePersonalPlace';
export const personalPlaceRole = z.enum(['home', 'work']);
export const privateLocation: Classification = { sensitivity: 'CONFIDENTIAL', compartments: [] };
export const placeAddress = z.string().trim().min(1).max(240);
export const placeCity = z.string().trim().min(1).max(100);
export const placeKey = z.string().regex(/^[a-f0-9]{64}$/);
export const personalPlaceRef = z.strictObject({ type: z.literal(personalPlaceType), id: placeKey });
export const personalPlaceInput = z.strictObject({
  role: personalPlaceRole,
  address: placeAddress,
  city: placeCity,
  confirmed: z.literal(true),
  expectedRevision: z.number().int().nonnegative(),
});
const placeIdentity = { id: placeKey, name: z.enum(['家', '公司']), role: personalPlaceRole };
export const personalPlaceRecord = z.strictObject({ ...placeIdentity, currentVersionNumber: z.number().int().positive() });

export const personalPlaceVersionRef = z.strictObject({ type: z.literal(personalPlaceVersionType), id: placeKey });
export const personalPlaceVersionRecord = z.strictObject({
  ...placeIdentity, version: z.number().int().positive(), address: placeAddress, city: placeCity,
});
const properties = (shape: typeof personalPlaceVersionRecord.shape | typeof personalPlaceRecord.shape) =>
  Object.fromEntries(Object.entries(shape).map(([name, field]) =>
    [name, { description: name, required: true, schema: json(field),
      ...(name === 'address' || name === 'city' ? { classification: privateLocation } : {}) }]));
const description = 'Save an address explicitly confirmed by the owner for future tasks. Use expectedRevision 0 for a new place, or the revision of the address being replaced.';
export const personalPlaceDefinition: Pick<OntologyDocument, 'objectTypes' | 'linkTypes' | 'actionTypes' | 'functionTypes'> = {
  objectTypes: [{
    apiName: personalPlaceType, displayName: '个人常用地点', description: 'An owner-scoped role with a current confirmed address version.',
    primaryKey: 'id', titleProperty: 'name', interfaces: {},
    properties: properties(personalPlaceRecord.shape),
  }, {
    apiName: personalPlaceVersionType, displayName: '常用地点版本',
    description: 'An immutable, owner-confirmed version of a personal place address.',
    primaryKey: 'id', titleProperty: 'name', interfaces: {}, properties: properties(personalPlaceVersionRecord.shape),
  }],
  linkTypes: [{
    apiName: personalPlaceHistoryLink, description: 'All confirmed versions of this personal place.',
    from: { type: personalPlaceType, name: 'versions', cardinality: 'many' },
    to: { type: personalPlaceVersionType, name: 'place', cardinality: 'one' },
  }, {
    apiName: currentPersonalPlaceVersionLink, description: 'The currently confirmed address version.',
    from: { type: personalPlaceType, name: 'currentVersion', cardinality: 'one' },
    to: { type: personalPlaceVersionType, name: 'currentFor', cardinality: 'one' },
  }],
  actionTypes: [{
    apiName: savePersonalPlace, description, parameters: json(personalPlaceInput),
    objectParameters: {}, submissionCriteria: [], function: personalPlaceEdit, classification: privateLocation,
  }],
  functionTypes: [{
    apiName: personalPlaceEdit, description, parameters: json(personalPlaceInput), returns: json(personalPlaceRef),
    dependencies: { objectTypes: [personalPlaceType, personalPlaceVersionType],
      linkTypes: [personalPlaceHistoryLink, currentPersonalPlaceVersionLink] }, edits: true, classification: privateLocation,
  }],
};
