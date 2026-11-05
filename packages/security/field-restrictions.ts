import {consentDeadline,type ConsentExpiry} from './consent-lifetime.js';
import type { Channel, SecurityEnvelope } from './envelope.js';

export type RecipientClearance={classification:'private'|'sensitive';markings:SecurityEnvelope['requiredMarkings'];channels:Channel[];expiresAt?:ConsentExpiry};
const rank={private:0,sensitive:1,internal:2} as const;

/** Field-level restriction comparison only; callers must still validate object
 * binding, source authority, provenance, lineage and output authorization. An
 * optional explicit clock checks a provided expiry without adding a default. */
export function restrictionsFitRecipient(restrictions:readonly SecurityEnvelope[],clearance:RecipientClearance|undefined,requireAgentResponse:boolean,now?:()=>number):boolean {
  return !!clearance && (!now||clearance.expiresAt===undefined||consentDeadline(clearance.expiresAt)>now()) && restrictions.every(envelope=>rank[envelope.classification]<=rank[clearance.classification]
    && envelope.requiredMarkings.every(marking=>clearance.markings.includes(marking))
    && (!requireAgentResponse || envelope.channels.includes('agent_response') && clearance.channels.includes('agent_response')));
}
