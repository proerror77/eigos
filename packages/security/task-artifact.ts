import {z} from 'zod';
import type {Job} from '../core/domain.js';
import {digest} from '../core/delegation.js';
import {documentDraftSchema} from '../ontology/document-action.js';

type Artifact=NonNullable<Job['artifact']>;
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const goal=z.object({version:z.literal('1'),goalDigest:sha,components:z.array(z.object({
  contextId:z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),status:z.enum(['verified','unverified']),artifact:z.unknown().optional(),
})).max(16)});
const marker=z.object({name:z.literal('deliverable.md'),data:z.object({result:z.object({modelGenerated:z.literal(true),noExternalActions:z.literal(true)})})});
const document=z.object({id:z.string().min(1).max(200),name:z.literal('deliverable.md'),data:z.object({
  goal:z.string().max(65536),deliverable:z.string().max(65536),execution:z.literal('completed'),markdown:z.string().min(1).max(40000),
  result:z.object({modelGenerated:z.literal(true),noExternalActions:z.literal(true),contentSha256:sha,citations:documentDraftSchema.shape.citations}),
})});
export interface GoalDocumentCandidate {contextId:string;document:z.infer<typeof document>}
export interface PublicGoalDocument {contextId:string;status:'verified';artifact:{id:string;name:'deliverable.md';data:{markdown:string}}}

/** Call only AFTER the whole original artifact passes its output seal. Other
 * provider/child payloads retain their opaque status. This is a fixed bounded
 * document contract, not recursive copying of arbitrary nested artifacts. */
export function goalDocumentCandidates(artifact:Artifact):GoalDocumentCandidate[]|undefined{
  if(artifact.name!=='goal-result.json')return [];
  const parsed=goal.safeParse(artifact.data.result);if(!parsed.success)return;
  const result:GoalDocumentCandidate[]=[];
  for(const component of parsed.data.components){
    if(component.status!=='verified'||!marker.safeParse(component.artifact).success)continue;
    const child=document.safeParse(component.artifact);
    if(!child.success||!child.data.data.markdown.trim()||child.data.data.goal!==artifact.data.goal||digest(child.data.data.markdown)!==child.data.data.result.contentSha256)return;
    result.push({contextId:component.contextId,document:child.data});
  }
  return result;
}

/** The caller supplies ONLY the current snapshot field read through its real
 * task graph/authorization facade. Missing field permission, another task or
 * revision, a changed document or invalid proof cannot produce public text. */
export function projectGoalDocument(candidate:GoalDocumentCandidate,currentSnapshot:unknown,taskId:string,requestRevision:number):PublicGoalDocument|undefined{
  const current=documentDraftSchema.safeParse(currentSnapshot);if(!current.success)return;
  const snapshot=current.data,child=candidate.document;
  if(snapshot.id!==child.id||snapshot.requestId!==taskId||snapshot.requestRevision!==requestRevision||snapshot.status!=='draft'
    ||snapshot.markdown!==child.data.markdown||snapshot.contentDigest!==child.data.result.contentSha256||digest(snapshot.markdown)!==snapshot.contentDigest
    ||digest(snapshot.citations)!==digest(child.data.result.citations))return;
  return {contextId:candidate.contextId,status:'verified',artifact:{id:child.id,name:child.name,data:{markdown:child.data.markdown}}};
}

/** Shared SQLite/PostgreSQL public shape. Its documents have already passed
 * both the full artifact seal and current typed DocumentDraft field checks. */
export function publicTaskArtifact(artifact:Artifact,observations:readonly object[],documents:readonly PublicGoalDocument[]):Artifact{
  const data=artifact.data;
  return {id:artifact.id,name:artifact.name,data:{...(typeof data.markdown==='string'?{markdown:data.markdown}:{}),goal:data.goal,deliverable:data.deliverable,execution:data.execution,
    ...(observations.length||documents.length?{result:{...(observations.length?{observations:[...observations]}:{}),...(documents.length?{components:[...documents]}:{})}}:{})}};
}
