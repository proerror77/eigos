import { z } from 'zod';
import { Conflict, NotFound, PermissionDenied } from '../core/identity.js';
import { compileMachineryExecution, processLogTarget, type ExecutableTransition } from '../ontology/process-definition.js';
import { objectRefSchema, ontologyName, type ObjectData, type ObjectRef } from '../ontology/schema.js';
import type { Access } from './access.js';
import type { Actions } from './actions.js';
import type { Database } from './database.js';
import type { PublishedOntology } from './metadata.js';
import { Objects } from './objects.js';

export const machineryNextActionsInput = z.strictObject({ object: objectRefSchema, process: ontologyName.optional() });

type Availability = 'ready' | 'needs_check' | 'blocked';

async function checkTransition(objects: Objects, subject: ObjectData, edge: ExecutableTransition): Promise<Availability> {
  try {
    const state = subject.properties[edge.process.property];
    if (typeof state !== 'string') return 'needs_check';
    if (state !== edge.from) return 'blocked';
    for (const guard of edge.execution.requires ?? []) {
      const target = processLogTarget(objects.model, guard.process)!;
      const related = guard.link ? await objects.readCompleteRelationship(subject.ref, guard.link) : { items: [subject], complete: true };
      if (!related.complete) return 'needs_check';
      const states = related.items.map(item => item.properties[target.property]);
      if (states.some(state => typeof state !== 'string')) return 'needs_check';
      if (!states.length) return 'blocked';
      const matches = (state: unknown) => guard.states.includes(state as string);
      if (!(guard.match === 'all' ? states.every(matches) : states.some(matches))) return 'blocked';
    }
    return 'ready';
  } catch (error) {
    if (error instanceof PermissionDenied || error instanceof NotFound || error instanceof Conflict) return 'needs_check';
    throw error;
  }
}

/** Called from the authoritative Action submission path, including validated direct calls. */
export async function requireMachineryTransition(objects: Objects, action: string, input: Record<string, unknown>) {
  const plans = compileMachineryExecution(objects.model).byAction.get(action);
  if (!plans?.length) return;
  const subjects = new Map<string, { ref: ObjectRef; transitions: ExecutableTransition[] }>();
  for (const edge of plans) {
    const ref = objectRefSchema.parse(input[edge.execution.subject]);
    if (ref.type !== edge.process.objectType) continue;
    const key = JSON.stringify([ref.type, ref.id, edge.process.type]);
    const subject = subjects.get(key) ?? { ref, transitions: [] };
    subject.transitions.push(edge);
    subjects.set(key, subject);
  }
  for (const { ref, transitions } of subjects.values()) {
    const object = await objects.read(ref);
    const checks = await Promise.all(transitions.map(edge => checkTransition(objects, object, edge)));
    if (!checks.includes('ready')) throw new Conflict('The published Machinery transition is not available');
  }
}

export class MachineryExecution {
  constructor(private readonly db: Database, private readonly actions: Actions) {}

  async nextActions(model: PublishedOntology, access: Access, raw: unknown) {
    const input = machineryNextActionsInput.parse(raw);
    const edges = compileMachineryExecution(model).byType.get(input.object.type) ?? [];
    const items = await this.db.transaction(async client => {
      await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', [], client);
      const graph = new Objects(this.db, model, access, client);
      const subject = await graph.read(input.object);
      const candidates = [] as {
        process: string; action: string; to: string; input: Record<string, unknown>;
        status: Availability | 'needs_input'; missing: string[];
      }[];
      for (const edge of edges) {
        if (input.process && input.process !== edge.process.type) continue;
        try {
          access.definition(model, 'object', edge.process.type);
          access.action(model, edge.action);
        } catch (error) {
          if (error instanceof PermissionDenied || error instanceof NotFound) continue;
          throw error;
        }
        const state = subject.properties[edge.process.property];
        if (typeof state === 'string' && edge.from !== state) continue;
        const parameters: Record<string, unknown> = { [edge.execution.subject]: subject.ref };
        for (const [name, property] of Object.entries(edge.execution.parameters ?? {})) {
          const value = subject.properties[property];
          if (value !== null && value !== undefined) parameters[name] = value;
        }
        const required = model.action(edge.action).parameters.required;
        const requiredFields = Array.isArray(required) ? required as string[] : [];
        const missing = requiredFields.filter(name => !Object.hasOwn(parameters, name));
        let status: Availability | 'needs_input' = await checkTransition(graph, subject, edge);
        if (status === 'ready' && missing.length) status = 'needs_input';
        if (status === 'ready') {
          try {
            await this.actions.validateSubmission(access, model, { action: edge.action, input: parameters }, client, AbortSignal.timeout(5000));
          } catch (error) {
            if (error instanceof Conflict) status = 'blocked';
            else if (error instanceof PermissionDenied || error instanceof NotFound || error instanceof z.ZodError) status = 'needs_check';
            else throw error;
          }
        }
        candidates.push({ process: edge.process.type, action: edge.action, to: edge.to, input: parameters, status, missing });
      }
      return candidates;
    });
    await access.refresh();
    if (!await access.canReturn(access.dataRequirements())) throw new PermissionDenied('Machinery result permissions changed');
    return { object: input.object, release: model.release, items };
  }
}
