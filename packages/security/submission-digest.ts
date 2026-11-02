import { digest } from '../core/delegation.js';
import type { ServiceRequest } from '../ontology/execution.js';

/** Bind retained evidence to the exact user-submitted request, without adding
 * derived interpretations to the user's original input. */
export function submissionDigest(request:ServiceRequest) {
  return digest({id:request.id,revision:request.revision,originalGoal:request.originalGoal,messages:request.messages,
    requirements:request.requirements.filter(r=>r.provenance.interpretation==='structured'),
    requestedDeliverable:request.requestedDeliverable,executionEnvironment:request.executionEnvironment});
}
