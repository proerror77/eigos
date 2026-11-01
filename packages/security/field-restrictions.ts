import type { Channel, SecurityEnvelope } from './envelope.js';

type Clearance={classification:'private'|'sensitive';markings:SecurityEnvelope['requiredMarkings'];channels:Channel[]};
const rank={private:0,sensitive:1,internal:2} as const;

/** Field-level restriction comparison only; callers must still validate object
 * binding, source authority, provenance, lineage and output authorization. */
export function restrictionsFitRecipient(restrictions:readonly SecurityEnvelope[],clearance:Clearance|undefined,requireAgentResponse:boolean):boolean {
  return !!clearance && restrictions.every(envelope=>rank[envelope.classification]<=rank[clearance.classification]
    && envelope.requiredMarkings.every(marking=>clearance.markings.includes(marking))
    && (!requireAgentResponse || envelope.channels.includes('agent_response') && clearance.channels.includes('agent_response')));
}
