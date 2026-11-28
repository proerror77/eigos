import type * as Wire from '../packages/sdk/contracts.js';
import type { Query } from '../packages/runtime/objects.js';
import type { ActionLogInput, ActionLogEntry } from '../packages/runtime/action-log.js';
import type {
  ScenarioComparisonInput,
  ScenarioComparison,
  ScenarioTrialInput,
  ScenarioTrial,
} from '../packages/runtime/scenario-evaluation.js';

// Fail the repository type check if client inputs or server results leave the wire contract.
type Fits<Expected, Actual extends Expected> = Actual;
export type ContractChecks = [
  Fits<Query, Wire.Query>,
  Fits<Wire.Query, Query>,
  Fits<ActionLogInput, Wire.ActionLogInput>,
  Fits<Wire.ActionLogEntry, ActionLogEntry>,
  Fits<ScenarioComparisonInput, Wire.ScenarioComparisonInput>,
  Fits<Wire.ScenarioComparison, ScenarioComparison>,
  Fits<ScenarioTrialInput, Wire.ScenarioTrialInput>,
  Fits<Wire.ScenarioTrial, ScenarioTrial>,
];
