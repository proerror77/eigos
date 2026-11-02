import { digest } from '../../core/delegation.js';
import { DomainError } from '../../core/domain.js';
import type { FliggyProgram } from '../../capabilities/fliggy/program.js';
import { fliggyActions } from '../fliggy.js';
import type { OntologyModel } from '../model.js';
import { parsePipelineIntake, type PipelineIntake } from './contracts.js';
import { mapPipelineFields } from './mapping.js';

/** Prepares a contract for the existing program's normalized product projection.
 * itemId is only an SPU identity. No SKU/room/availability relationship is guessed,
 * no second set of source identities is ingested, and nothing is activated. */
export function prepareFliggyProductPipeline(options: {
  model: OntologyModel; program: FliggyProgram; serviceId: string;
  source: PipelineIntake['source']; samples: Record<string,unknown>[];
}): PipelineIntake {
  const {model,program} = options, actionId='SearchFliggyMarriottPackages';
  const action=model.action(actionId), expected=fliggyActions.find(a=>a.id===actionId)!;
  if(program.ref.id!=='fliggy.travel.search' || digest(action.read)!==digest(expected.read)
    || model.objectWritePolicy('TravelProduct')!=='source') throw new DomainError('INVALID_INPUT','Expected the exact existing Fliggy product source binding');
  if(!options.samples.length || options.samples.length>10) throw new DomainError('INVALID_INPUT','Provide one to ten existing normalized product samples');
  const fields=['displayTitle','sourceId','name','classification'];
  const mapping={id:'travel-product',objectType:'TravelProduct',nativeId:['sourceId'],maxAgeMs:300000,
    fields:fields.map(name=>({from:[name],to:[name],optional:false}))};
  const fixtures=options.samples.map(sample=>{
    model.parseProperties('TravelProduct',sample);
    if(Object.keys(sample).some(key=>key!=='id' && !fields.includes(key)) || typeof sample.sourceId!=='string' || !sample.sourceId)
      throw new DomainError('INVALID_INPUT','Unreviewed product fields or missing source identity');
    const expected=mapPipelineFields(mapping,sample),{id:_,...properties}=sample;
    if(digest(expected)!==digest(properties)) throw new DomainError('INVALID_INPUT','Mapping loses observed product fields');
    return {mappingId:mapping.id,input:structuredClone(sample),expected};
  });
  const environment=program.capability().environment!;
  return parsePipelineIntake({format:'eigos.ontology.pipeline.v1',serviceId:options.serviceId,source:options.source,
    programRef:program.ref,configurationDigest:program.configurationDigest,environment,
    vocabulary:[{term:'旅行渠道商品 SPU',aliases:['来源 itemId；非 SKU'],objectType:'TravelProduct'}],
    actions:[{actionId,definitionDigest:digest(action),requiredEvidence:environment==='sandbox'?'synthetic':'live_readonly'}],
    mappings:[mapping],fixtures,conditions:{regions:[],payment:'not_required',operatorRequired:false}});
}
