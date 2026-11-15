import { z } from 'zod';
import { objectRefSchema } from './schema.js';

const argumentsSchema = z.record(z.string(), z.unknown());
const call = { scenarioId: z.uuid().optional(), input: argumentsSchema };

/** A capability constraint resolves to a concrete published Action. */
export const interfaceActionTargetSchema = z.strictObject({
  object: objectRefSchema.optional(), implementation: z.string().optional(),
  type: z.string(), action: z.string(),
}).refine(value => !!value.object !== !!value.implementation, 'Select an existing object or an implementing Object Type');

export const interfaceActionCallSchema = z.strictObject({
  ...call, interface: interfaceActionTargetSchema,
});

export const actionCallSchema = z.strictObject({
  ...call,
  action: z.string().optional(), interface: interfaceActionTargetSchema.optional(),
}).refine(value => !!value.action !== !!value.interface, 'Select an Action or an Interface Action');

export const actionResultReadSchema = z.strictObject({
  function: z.string().min(1),
  resultParameter: z.string().min(1),
  input: argumentsSchema.optional(),
});
export const completeWithActionSchema = z.strictObject({
  action: interfaceActionCallSchema,
  read: actionResultReadSchema,
});
export type ActionResultRead = z.infer<typeof actionResultReadSchema>;

export const completeWithActionRequestSchema = completeWithActionSchema.safeExtend({
  ontology: z.string().optional(),
  requestId: z.string().min(1).max(128),
});

export const functionCallSchema = z.strictObject({
  ...call, function: z.string(),
});

/** Protocol metadata does not change the operation or its Scenario view. */
export const actionRequestSchema = actionCallSchema.safeExtend({
  ontology: z.string().optional(), requestId: z.string().min(1).max(128),
});
export const functionRequestSchema = functionCallSchema.safeExtend({
  ontology: z.string().optional(), taskId: z.uuid().optional(),
});

export type ActionCall = z.infer<typeof actionCallSchema>;
export type ActionInput = Omit<z.infer<typeof actionRequestSchema>, 'ontology' | 'scenarioId'>;
