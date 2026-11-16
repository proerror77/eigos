import type { ObjectRef } from '../ontology/schema.js';
import type { Access } from './access.js';
import type { Actions } from './actions.js';
import type { AgentTool } from './agent.js';
import type { Metadata, PublishedOntology } from './metadata.js';
import type { Task, Tasks } from './tasks.js';

export type AgentTaskPrompt = (
  model: PublishedOntology,
  access: Access,
  input: Omit<Task['input'], 'classification'>,
) => {
  userRequest: Record<string, unknown>;
  context: Record<string, unknown>;
  instructions: readonly string[];
} | undefined;

type SelectedAction = { action: string; input: Record<string, unknown> };
type Replay = (tools: ReadonlyMap<string, AgentTool>) => Promise<void>;

interface WorkflowSession {
  recordAction(selected: SelectedAction, scenarioId: string | undefined, output: ObjectRef): void;
  recordEvent(tool: string, input: unknown, output: unknown): Promise<void>;
  prepareReplay?: () => Promise<Replay>;
  complete(result: unknown): Promise<unknown>;
}

export type AgentTaskWorkflow = (context: {
  task: Task; tasks: Tasks; metadata: Metadata; access: Access; actions: Actions;
  model: PublishedOntology; signal: AbortSignal;
}) => {
  replay: boolean;
  catalogue: { profiles: readonly string[]; resources: readonly string[] };
  instructions: readonly string[];
  checkTool(tool: string, input: unknown): void;
  checkAction(action: string, scenarioId?: string): void;
  allowsAction(action: string): boolean;
  start(): Promise<WorkflowSession>;
} | undefined;
