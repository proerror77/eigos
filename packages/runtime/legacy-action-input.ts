import { z } from 'zod';
import { Conflict } from '../core/identity.js';
import { placeAmendmentSchema, placeChoicesSchema, placeSelectionSchema, taskInputAnswerSchema, type ActionContinuation } from './clarification.js';
import type { Task } from './tasks.js';

const selection = z.strictObject({ kind: z.literal('select'), places: placeSelectionSchema });
const amendment = z.strictObject({ kind: z.literal('amend'), amendment: placeAmendmentSchema });
const placeAnswer = z.union([selection, amendment]);

export function legacyActionInput(wait: ActionContinuation) {
  const kind = wait.waitingFor;
  if (kind === 'pa-request') return;
  const schema = kind ? taskInputAnswerSchema.options.find(option => option.shape.kind.value === kind) : placeAnswer;
  if (!schema) throw new Conflict('Unknown Action input contract');
  return { capability: kind ? 'task.input.' + kind : 'task.input.places',
    purpose: kind === 'retry-source' ? 'observation' as const : 'input' as const,
    responseSchema: z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) };
}

export function applyLegacyActionInput(task: Task, input: unknown): Task['input'] {
  const wait = task.input.placeContinuation;
  if (wait?.waitingFor && wait.waitingFor !== 'pa-request') {
    const answer = taskInputAnswerSchema.parse(input);
    if (answer.kind !== wait.waitingFor || z.object({ kind: z.string() }).parse(task.result).kind !== answer.kind)
      throw new Conflict('The original Action is not waiting for this input');
    switch (answer.kind) {
      case 'city': return { ...task.input, rideCity: answer.city };
      case 'origin': return { ...task.input, rideOrigin: answer.place };
      case 'destination': return { ...task.input, rideDestination: answer.place };
      case 'retry-source': return task.input;
    }
  }
  const answer = placeAnswer.parse(input);
  const candidates = placeChoicesSchema.safeParse(task.result);
  if (!candidates.success) throw new Conflict('The original task has no place candidates');
  const choices = candidates.data;
  const match = (side: 'origin' | 'destination', ref: { type: string; id: string }) =>
    choices[side].find(candidate => candidate.ref.type === ref.type && candidate.ref.id === ref.id)?.ref;
  if (answer.kind === 'select') {
    if (!match('origin', answer.places.origin) || !match('destination', answer.places.destination))
      throw new Conflict('Select places from the original task’s current candidates');
    return { ...task.input, places: answer.places };
  }
  if (!wait?.receipts) throw new Conflict('There is no original Action waiting for place details');
  const { side, keep, ...clue } = answer.amendment;
  const other = side === 'origin' ? 'destination' : 'origin';
  const selected = keep ? match(other, keep) : choices[other].length === 1 ? choices[other][0]!.ref : undefined;
  if (!selected && (keep || choices[other].length))
    throw new Conflict('Identify the unchanged endpoint from the original task’s current candidates');
  return { ...task.input, places: selected ? { [other]: selected } : {},
    placeAmendments: { ...task.input.placeAmendments, [side]: clue } };
}
