import { z } from 'zod';
import { ontologyName, type OntologyDocument } from './schema.js';

export const publicPlacesOntology = 'EigosPublicPlaces';
export const publicPlaceType = 'PublicPlace';
export const publishPublicPlace = 'PublishPublicPlace';
export const revisePublicPlace = 'RevisePublicPlace';
export const withdrawPublicPlace = 'WithdrawPublicPlace';

const placeFields = {
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  name: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(120),
  address: z.string().trim().min(1).max(300),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  coordinateSystem: z.literal('WGS84'),
};
const revision = z.number().int().positive();
const published = z.boolean();
const confirmation = z.literal(true);
const request = { project: ontologyName, requestId: z.string().min(1).max(128) };
const placeRef = z.strictObject({ type: z.literal(publicPlaceType), id: placeFields.id });
const publish = z.strictObject({ ...placeFields, confirmedPublic: confirmation });
const revise = publish.omit({ id: true }).extend({ place: placeRef, revision });
const withdraw = z.strictObject({ place: placeRef, revision });
const json = (schema: z.ZodType) => z.toJSONSchema(schema);
const parameter = (name: string) => ({ parameter: name });
const typeProperties = Object.fromEntries(Object.entries({ ...placeFields, published }).map(([field, schema]) =>
  [field, { schema: json(schema), description: field, required: true }]));
const editableFields = Object.fromEntries(Object.keys(placeFields).filter(field => field !== 'id').map(field =>
  [field, parameter(field)]));

export const listPublicPlacesSchema = z.strictObject({
  project: ontologyName,
  id: placeFields.id.optional(),
  city: placeFields.city.optional(),
  cursor: z.string().max(2000).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  includeWithdrawn: z.boolean().optional(),
});
export const publishPublicPlaceSchema = publish.extend({ ...request, revision: revision.optional() });
export const withdrawPublicPlaceSchema = z.strictObject({ ...request, id: placeFields.id, revision });

export const publicPlacesDefinition: OntologyDocument = {
  id: publicPlacesOntology,
  version: '1',
  objectTypes: [{
    apiName: publicPlaceType, displayName: 'Public place',
    description: 'A place explicitly published in an organization project catalogue, with WGS84 coordinates.',
    primaryKey: 'id', titleProperty: 'name', interfaces: {}, properties: typeProperties,
  }],
  interfaceTypes: [],
  linkTypes: [],
  functionTypes: [],
  dataSources: [],
  actionTypes: [{
    apiName: publishPublicPlace, description: 'Publish reviewed public location fields in the catalogue.',
    parameters: json(publish), objectParameters: {}, submissionCriteria: [],
    result: { type: publicPlaceType, id: parameter('id') },
    rules: [{
      op: 'createObject', object: { type: publicPlaceType, id: parameter('id') },
      properties: { id: parameter('id'), ...editableFields, published: { literal: true } },
    }],
  }, {
    apiName: revisePublicPlace, description: 'Revise or republish a public place at its reviewed revision.',
    parameters: json(revise), objectParameters: { place: publicPlaceType }, submissionCriteria: [],
    result: { type: publicPlaceType, id: { parameter: 'place', path: ['id'] } },
    rules: [{
      op: 'editObject', object: parameter('place'), expectedRevision: parameter('revision'),
      properties: { ...editableFields, published: { literal: true } },
    }],
  }, {
    apiName: withdrawPublicPlace, description: 'Withdraw a public place from the catalogue at its reviewed revision.',
    parameters: json(withdraw), objectParameters: { place: publicPlaceType }, submissionCriteria: [],
    result: { type: publicPlaceType, id: { parameter: 'place', path: ['id'] } },
    rules: [{
      op: 'editObject', object: parameter('place'), expectedRevision: parameter('revision'),
      properties: { published: { literal: false } },
    }],
  }],
};
