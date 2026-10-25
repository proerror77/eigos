import snapshot from './history/didi-readonly-v1.json' with { type: 'json' };
import { parseMcpReadModule, mcpReadModuleRef } from './mcp-read.js';
import { rideEstimateActions, rideEstimateFunctions } from './ride-estimate.js';
// Exact immutable binding from main f4843aa. The v20 fingerprint check remains
// authoritative; current input/schema drift cannot silently replace this release.
const definition = parseMcpReadModule(snapshot), ref = mcpReadModuleRef(definition);
export const predecessorRideActions = rideEstimateActions.map(action => {
  const old = definition.actions.find(value => value.id === action.id);
  if (!old || !action.read) throw new Error('Missing original DiDi read contract');
  return { ...action, description: old.description, read: { ...action.read, version: definition.version, mcp: old.mcp, module: { ...ref, completion: definition.completion } } };
});
export const predecessorRideFunctions = rideEstimateFunctions.filter(fn => fn.id === 'rideEstimateStatus');
