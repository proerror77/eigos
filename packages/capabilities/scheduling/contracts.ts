import { z } from 'zod';
import { objectRefSchema } from '../../ontology/schema.js';

export const timestamp = z.iso.datetime({ offset: true });
export const intervalSchema = z.strictObject({ start: timestamp, end: timestamp });
export const timeZoneSchema = z.string().min(1).max(100);
export const planInputSchema = z.strictObject({ title: z.string().min(1).max(200), start: timestamp, end: timestamp,
  timeZone: timeZoneSchema, durationMinutes: z.number().int().min(1).max(1440), plan: objectRefSchema.optional(), scenarioId:z.uuid().optional() });
export const calendarResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available'), complete: z.literal(true), start: timestamp, end: timestamp, timeZone: timeZoneSchema,
    observedAt: timestamp, expiresAt: timestamp, sourceVersion: z.string().min(1).max(200),
    evidence: z.enum(['pa_reported', 'synthetic']), calendars: z.array(z.string().min(1).max(200)).min(1).max(50),
    windows: z.array(intervalSchema).max(500), busy: z.array(intervalSchema).max(1000) }),
  z.strictObject({ status: z.enum(['denied', 'unavailable', 'incomplete']), reason: z.string().min(1).max(500) }),
]);
export type CalendarResponse = z.infer<typeof calendarResponseSchema>;
export const activityInputSchema = z.strictObject({ plan: objectRefSchema, id: z.string().min(1).max(128), name: z.string().min(1).max(200),
  start: timestamp, end: timestamp, activity:objectRefSchema.optional(), revision: z.number().int().positive().optional(), predecessors: z.array(objectRefSchema).max(20).default([]) });
export const removeActivitySchema = z.strictObject({ activity: objectRefSchema, revision: z.number().int().positive() });
export const planRefSchema = z.strictObject({ plan: objectRefSchema });
export const searchSlotsSchema = planRefSchema.extend({ limit: z.number().int().min(1).max(20).default(5),
  stepMinutes: z.number().int().min(1).max(1440).default(15), ignoreActivity: objectRefSchema.optional() });
export const commitPlanSchema = z.strictObject({ plan: objectRefSchema, scenarioId: z.uuid(), revision: z.number().int().positive() });
export const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema) as Record<string, unknown>;

const objectData = z.strictObject({ ref: objectRefSchema, revision: z.number().int().positive(), properties: z.record(z.string(),z.unknown()) });
export const validationResultSchema = z.strictObject({valid:z.boolean(),evaluatedAt:timestamp,
  violations:z.array(z.strictObject({severity:z.literal('hard'),code:z.string(),activity:objectRefSchema,related:z.array(objectRefSchema)})),
  calendarEvidence:z.array(z.strictObject({resource:objectRefSchema,sourceVersion:z.string(),observedAt:timestamp,expiresAt:timestamp,evidence:z.enum(['pa_reported','synthetic'])})),
  externalCalendarUpdated:z.literal(false)});
export const slotsResultSchema=z.strictObject({plan:objectRefSchema,slots:z.array(intervalSchema),timeZone:timeZoneSchema,resources:z.array(objectRefSchema),calendarEvidence:validationResultSchema.shape.calendarEvidence,evaluatedAt:timestamp,externalCalendarUpdated:z.literal(false)});
export const planResultSchema=z.strictObject({plan:objectData,activities:z.array(objectData),validation:validationResultSchema,scenarioId:z.uuid().nullable(),externalCalendarUpdated:z.literal(false)});
