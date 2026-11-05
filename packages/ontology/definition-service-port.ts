import type {DefinitionService} from './definition-service.js';

type AwaitableMethods<T,K extends keyof T>={
  [P in K]:T[P] extends (...args:infer A)=>infer R?(...args:A)=>R|Promise<Awaited<R>>:never;
};

/** The same definition contracts over an awaited storage implementation. */
export type DefinitionServicePort=Pick<DefinitionService,'secured'>&AwaitableMethods<DefinitionService,'query'|'command'|'prepare'|'approve'>;
