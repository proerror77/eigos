import { z } from 'zod';
import { Conflict, NotFound, PermissionDenied } from '../core/identity.js';
import { compileMachineryExecution, processLogTarget, type ExecutableTransition } from '../ontology/process-definition.js';
import { objectRefSchema, ontologyName, type ObjectData, type ObjectRef } from '../ontology/schema.js';
import type { Access } from './access.js';
import type { Actions } from './actions.js';
import type { Database, Sql } from './database.js';
import type { PublishedOntology } from './metadata.js';
import { Objects } from './objects.js';

export const machineryNextActionsInput = z.strictObject({ object: objectRefSchema, process: ontologyName.optional() });

export const machineryReplanInput = z.strictObject({
  changedObjects: z.array(objectRefSchema).min(1).max(100),
});

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

  /** Re-read the changed subjects and the parents reached through published transition guards. */
  async replan(model: PublishedOntology, access: Access, raw: unknown) {
    const { changedObjects } = machineryReplanInput.parse(raw);
    const { byType } = compileMachineryExecution(model);
    const parents = new Map<string, Set<string>>();
    for (const [type, edges] of byType) {
      for (const edge of edges) {
        for (const guard of edge.execution.requires ?? []) {
          if (!guard.link) continue;
          const nav = model.navigation(type, guard.link);
          const link = model.links.get(nav.link)!;
          const reverse = nav.forward ? link.to.name : link.from.name;
          const paths = parents.get(nav.target) ?? new Set<string>();
          paths.add(reverse);
          parents.set(nav.target, paths);
        }
      }
    }
    const items = await this.db.transaction(async client => {
      await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', [], client);
      const graph = new Objects(this.db, model, access, client);
      const subjects = new Map<string, ObjectRef>();
      const include = (ref: ObjectRef) => subjects.set(JSON.stringify([ref.type, ref.id]), ref);
      for (const ref of changedObjects) {
        await graph.read(ref);
        if (byType.has(ref.type)) include(ref);
        for (const path of parents.get(ref.type) ?? []) {
          const related = await graph.readCompleteRelationship(ref, path);
          if (!related.complete) throw new Conflict('Cannot resolve the complete set of affected processes');
          for (const item of related.items) include(item.ref);
        }
      }
      const updated = [];
      for (const object of subjects.values()) updated.push(await this.evaluate(model, access, { object }, client));
      return updated;
    });
    await access.refresh();
    if (!await access.canReturn(access.dataRequirements())) throw new PermissionDenied('Machinery result permissions changed');
    return { release: model.release, items };
  }

  async nextActions(model: PublishedOntology, access: Access, raw: unknown) {
    const input = machineryNextActionsInput.parse(raw);
    const result = await this.db.transaction(async client => {
      await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', [], client);
      return this.evaluate(model, access, input, client);
    });
    await access.refresh();
    if (!await access.canReturn(access.dataRequirements())) throw new PermissionDenied('Machinery result permissions changed');
    return result;
  }

  private async evaluate(model: PublishedOntology, access: Access, input: z.infer<typeof machineryNextActionsInput>, client: Sql) {
    const edges = compileMachineryExecution(model).byType.get(input.object.type) ?? [];
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
    return { object: input.object, release: model.release, items: candidates };
  }
}
