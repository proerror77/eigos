import type { AgentStep } from '../../packages/ontology/agent-actions.js';
import type { ObjectRef } from '../../packages/ontology/model.js';
import { input } from './didi.js';

export function didiDataflow(scope?: ObjectRef): AgentStep[] {
  const base = scope ? { scope } : {};
  return [
    { id: 'to', action: 'SearchDidiPlaces', argumentsJson: JSON.stringify({ ...base, role: 'destination', keywords: input.destination }), dependsOn: [], inputRefs: [] },
    { id: 'from', action: 'SearchDidiPlaces', argumentsJson: JSON.stringify({ ...base, role: 'origin', keywords: input.origin }), dependsOn: [], inputRefs: [] },
    { id: 'price', action: 'EstimateDidiRide', argumentsJson: JSON.stringify(base), dependsOn: ['from', 'to'], inputRefs: [
      { stepId: 'from', targetKey: 'originObservation' },
      { stepId: 'from', targetKey: 'originPlaceId', compute: { function: 'selectDidiPlace', path: ['placeId'] } },
      { stepId: 'to', targetKey: 'destinationObservation' },
      { stepId: 'to', targetKey: 'destinationPlaceId', compute: { function: 'selectDidiPlace', path: ['placeId'] } },
    ] },
  ];
}
export const dataflowCompletion = { argumentsJson: JSON.stringify({ rationale: 'Deliver the requested source estimates after fresh independent checks' }), inputRefs: [{ stepId: 'price', targetKey: 'observation' }] };
