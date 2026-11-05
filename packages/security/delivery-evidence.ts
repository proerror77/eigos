import { z } from 'zod';
import type { Job } from '../core/domain.js';
import { objectRefSchema, type ObjectRef } from '../ontology/model.js';

const evidenceMetadata=z.object({securityEvidenceRefs:z.array(objectRefSchema).max(20).optional()});
const goalResult=z.object({version:z.literal('1'),goalDigest:z.string().regex(/^[a-f0-9]{64}$/),components:z.array(z.object({
  contextId:z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),status:z.enum(['verified','unverified']),artifact:z.unknown().optional(),
})).max(16)});
const componentArtifact=z.object({data:z.object({execution:z.literal('completed'),result:evidenceMetadata.optional()})});
const partialGoalResult=z.object({version:z.literal('1'),goalDigest:z.string().regex(/^[a-f0-9]{64}$/),accepted:z.literal(false),
  observedResults:z.array(z.object({object:objectRefSchema,currentObjectUnavailable:z.boolean().optional()})).max(12)});

/** Read only reviewed reference slots from the sealed delivery. Child payloads
 * are never public data; every extracted ref still passes the current graph ACL. */
export function deliveryEvidence(artifact:NonNullable<Job['artifact']>):ObjectRef[]|undefined {
  const metadata=evidenceMetadata.safeParse(artifact.data.result??{});
  if(!metadata.success)return;
  const refs=[...(metadata.data.securityEvidenceRefs??[])];
  if(artifact.name==='goal-result.json') {
    const result=goalResult.safeParse(artifact.data.result);if(!result.success)return;
    for(const component of result.data.components) {
      if(component.status!=='verified')continue;
      const child=componentArtifact.safeParse(component.artifact);if(!child.success)return;
      refs.push(...(child.data.data.result?.securityEvidenceRefs??[]));
    }
  } else if(artifact.name==='partial-goal-result.json') {
    const result=partialGoalResult.safeParse(artifact.data.result);if(!result.success)return;
    refs.push(...result.data.observedResults.filter(item=>!item.currentObjectUnavailable).map(item=>item.object));
  }
  const unique=[...new Map(refs.map(ref=>[JSON.stringify(ref),ref])).values()];
  return unique.length<=20?unique:undefined;
}
