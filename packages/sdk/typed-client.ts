import type { ObjectRef } from '../ontology/schema.js';
import type { OntologyClient } from './client.js';

export type OntologyBindings = {
  objects: Record<string, Record<string, unknown>>;
  actions: Record<string, Record<string, unknown>>;
  functions: Record<string, { input: Record<string, unknown>; result: unknown }>;
};

type Name<T> = Extract<keyof T, string>;
type BatchAction<Actions> = {
  [K in Name<Actions>]: { action: K; input: Actions[K]; requestId: string };
}[Name<Actions>];
type Query = Parameters<OntologyClient['query']>[0];
type QueryOptions = Parameters<OntologyClient['query']>[1];

/** A TypeScript view of the existing client, parameterized by a published definition's generated types. */
export class TypedOntologyClient<T extends OntologyBindings> {
  constructor(private readonly client: OntologyClient) {}

  query<K extends Name<T['objects']>>(query: Omit<Query, 'type'> & { type: K }, options?: QueryOptions) {
    return this.client.query<{
      ref: ObjectRef;
      revision: number;
      properties: { [P in keyof T['objects'][K]]?: T['objects'][K][P] | null };
    }>(query, options);
  }

  evaluate<K extends Name<T['functions']>>(name: K, input: T['functions'][NoInfer<K>]['input'], options?: QueryOptions) {
    return this.client.evaluate<T['functions'][K]['result']>(name, input, options);
  }

  apply<K extends Name<T['actions']>>(action: K, input: T['actions'][NoInfer<K>], requestId: string,
    options?: Parameters<OntologyClient['apply']>[1]) {
    return this.client.apply({ action, input, requestId }, options);
  }

  validateAction<K extends Name<T['actions']>>(action: K, input: T['actions'][NoInfer<K>],
    options: { scenarioId?: string; signal?: AbortSignal } = {}) {
    return this.client.validateAction({ action, input, scenarioId: options.scenarioId }, options.signal);
  }

  applyActionBatch(actions: BatchAction<T['actions']>[], signal?: AbortSignal) {
    return this.client.applyActionBatch({ actions }, signal);
  }
}
