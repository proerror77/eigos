import { z } from 'zod';
import { type OntologyDocument } from './schema.js';
import type { Classification } from './classification.js';
import { json } from './service-contracts.js';

export const personalPlaceType = 'PersonalPlace';
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
export const personalPlaceRecord = personalPlaceInput.pick({ role: true, address: true, city: true }).extend({
  id: placeKey,
  name: z.enum(['家', '公司']),
});

const description = 'Save an address explicitly confirmed by the owner for future tasks. Use expectedRevision 0 for a new place, or the revision of the address being replaced.';
export const personalPlaceDefinition: Pick<OntologyDocument, 'objectTypes' | 'actionTypes' | 'functionTypes'> = {
  objectTypes: [{
    apiName: personalPlaceType, displayName: '个人常用地点', description: 'An address the owner confirmed for a stable role.',
    primaryKey: 'id', titleProperty: 'name', interfaces: {},
    properties: Object.fromEntries(Object.entries(personalPlaceRecord.shape).map(([name, field]) =>
      [name, { description: name, required: true, schema: json(field),
        ...(name === 'address' || name === 'city' ? { classification: privateLocation } : {}) }])),
  }],
  actionTypes: [{
    apiName: savePersonalPlace, description, parameters: json(personalPlaceInput),
    objectParameters: {}, submissionCriteria: [], function: personalPlaceEdit, classification: privateLocation,
  }],
  functionTypes: [{
    apiName: personalPlaceEdit, description, parameters: json(personalPlaceInput), returns: json(personalPlaceRef),
    dependencies: { objectTypes: [personalPlaceType] }, edits: true, classification: privateLocation,
  }],
};
