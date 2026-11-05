import {z} from 'zod';
import {digest} from '../core/delegation.js';
import {DomainError} from '../core/domain.js';
import {objectRefSchema,nameSchema,type FunctionDefinition,type ObjectRef} from './model.js';
import {ontologyReleaseRefSchema,type OntologyReleaseRef} from './definition-contracts.js';

const sha=z.string().regex(/^[a-f0-9]{64}$/);
export const embeddingSpaceSchema=z.strictObject({modelId:z.string().min(1).max(200),modelRevision:z.string().min(1).max(200),
  dimensions:z.number().int().min(1).max(16000),metric:z.literal('cosine'),inputFormat:z.literal('canonical-fields-json-v1')});
export type EmbeddingSpace=z.infer<typeof embeddingSpaceSchema>;
const fields=z.array(nameSchema).min(1).max(20).refine(values=>new Set(values).size===values.length,'Duplicate embedded field');
const vector=z.array(z.number().finite()).min(1).max(16000);
export const embeddingObjectSchema=z.strictObject({object:objectRefSchema,expectedObjectRevision:z.number().int().positive().safe(),fields,
  fieldsDigest:sha,inputDigest:sha});
export const syncTaskEmbeddingsSchema=z.strictObject({version:z.literal(1),taskId:z.uuid(),expectedRequestRevision:z.number().int().positive().safe(),
  ontologyRelease:ontologyReleaseRefSchema,batchId:z.uuid(),space:embeddingSpaceSchema,
  rows:z.array(embeddingObjectSchema.extend({vector})).min(1).max(50)});
export const semanticCandidatesSchema=z.strictObject({function:z.literal('semanticCandidates'),object:objectRefSchema,
  space:embeddingSpaceSchema,queryVector:vector,candidates:z.array(embeddingObjectSchema.extend({batchId:z.uuid(),batchDigest:sha})).min(1).max(50),
  limit:z.number().int().min(1).max(50).default(10)});
export type SemanticCandidatesCall=z.infer<typeof semanticCandidatesSchema>;
export const semanticCandidatesDefinition:FunctionDefinition={id:'semanticCandidates',version:'1',inputTypes:['ServiceRequest'],
  description:'Rank an explicit, completely indexed current task ObjectSet using supplied vectors. Candidates are not verified facts or permission to execute a business action.'};
Object.freeze(semanticCandidatesDefinition.inputTypes);Object.freeze(semanticCandidatesDefinition);

/** Exact producer input contract. Missing and null are distinct; no private
 * value is accepted in place of a fresh authorized field projection. */
export function embeddedFieldInput(release:OntologyReleaseRef,ref:ObjectRef,revision:number,selected:readonly string[],properties:Record<string,unknown>){
  const names=fields.parse(selected).sort(),values=names.map(name=>Object.hasOwn(properties,name)?{name,present:true,value:properties[name]}:{name,present:false});
  const payload={version:1,ontologyRelease:ontologyReleaseRefSchema.parse(release),object:objectRefSchema.parse(ref),revision,fields:values};
  return {fields:names,fieldsDigest:digest(values),inputDigest:digest(payload)};
}
export function checkedEmbeddingVector(input:unknown,dimensions:number){
  const values=vector.parse(input);if(values.length!==dimensions)throw new DomainError('INVALID_INPUT','Embedding dimension differs from its space');
  const normalized=values.map(value=>{const rounded=Math.fround(value);return Object.is(rounded,-0)?0:rounded;});
  if(normalized.some(value=>!Number.isFinite(value))||!normalized.some(value=>value!==0))throw new DomainError('INVALID_INPUT','Cosine vectors require finite nonzero float32 values');
  const bytes=Buffer.alloc(normalized.length*4);normalized.forEach((value,index)=>bytes.writeFloatLE(value,index*4));
  return {values:normalized,digest:digest({encoding:'float32-le-v1',bytes:bytes.toString('base64')})};
}
export function assertEmbeddingInputBound(input:unknown){
  if(Buffer.byteLength(JSON.stringify(input))>60000)throw new DomainError('INVALID_INPUT','Supplied vectors exceed the existing request byte bound; split the batch');
}
