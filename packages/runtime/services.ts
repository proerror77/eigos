import { z } from 'zod';
import type { Principal } from '../core/identity.js';
import { requireScope } from '../core/identity.js';
import { objectRefSchema } from '../ontology/schema.js';
import { Access } from './access.js';
import { Database } from './database.js';
import { Metadata } from './metadata.js';
import { Scenarios } from './scenarios.js';
import { Objects } from './objects.js';
import { ObjectSets, evaluateSetSchema, aggregateSetSchema, saveSetSchema, listSetsSchema } from './object-sets.js';
import { Indexing, indexingInputSchema } from './indexing.js';
import { Materializations, materializationInputSchema } from './materializations.js';
import { EditHistory, conflictPolicySchema, setConflictPolicy } from './edit-history.js';
import { Governance, projectSchema, assignProjectSchema, branchCreateSchema, branchRevisionSchema, branchReviewSchema, branchUpdateSchema } from './governance.js';
import { Effects } from './effects.js';
import type { Functions } from './functions.js';
import type { Bindings } from './metadata.js';

export function ontologyServices(db: Database, metadata: Metadata, bindings: Bindings, functions: Functions, effects: Effects) {
  const sets=new ObjectSets(db), indexing=new Indexing(db,metadata), materializations=new Materializations(db), governance=new Governance(db,metadata,bindings);
  const idSchema=z.strictObject({id:z.uuid()}), ontology=z.strictObject({ontology:z.string().default('Eigos')});
  const services=new Map<string,{schema:z.ZodType; description:string; invoke:(principal:Principal,input:unknown)=>Promise<unknown>}>();
  const register=<S extends z.ZodType>(name:string,description:string,schema:S,write:boolean,run:(access:Access,input:z.output<S>)=>Promise<unknown>)=>{
    services.set(name,{schema,description,invoke:async(principal,raw)=>{
      requireScope(principal,write?'ontology:write':'ontology:read');
      const access=await Access.load(db,principal),result=await run(access,schema.parse(raw));
      if (!write && !await access.canReturn(access.dataRequirements())) throw new Error('Result permissions changed');
      return result;
    }});
  };
  const view=async(access:Access,scenarioId?:string)=>{
    const model=await metadata.active();
    return scenarioId?new Scenarios(db).view(access,model,scenarioId):model;
  };
  register('evaluate_set','Evaluate a composed or saved object set with current permissions.',evaluateSetSchema.extend({scenarioId:z.uuid().optional()}),false,async(a,{scenarioId,...input})=>sets.evaluate(a,await view(a,scenarioId),input));
  register('aggregate_set','Group and aggregate a complete authorized object set.',aggregateSetSchema.extend({scenarioId:z.uuid().optional()}),false,async(a,{scenarioId,...input})=>sets.aggregate(a,await view(a,scenarioId),input));
  register('save_set','Save static membership or a dynamic set definition with explicit readers.',saveSetSchema,true,async(a,input)=>sets.save(a,await metadata.active(),input));
  register('get_set','Read a saved object set definition permitted to this identity.',idSchema,false,async(a,input)=>sets.get(a,await metadata.active(),input.id));
  register('list_sets','List owned and shared set definitions.',listSetsSchema,false,async(a,input)=>sets.list(a,await metadata.active(),input));
  register('delete_set','Delete an owned saved set at its reviewed revision.',idSchema.extend({revision:z.number().int().positive()}),true,async(a,input)=>sets.remove(a,await metadata.active(),input.id,input.revision));
  register('submit_index','Submit an authorized source transaction with ordered offset.',indexingInputSchema,true,async(a,input)=>indexing.submit(a,await metadata.active(),input));
  register('index_status','Read durable source indexing progress.',idSchema,false,async(a,input)=>indexing.inspect(a,await metadata.active(),input.id));
  register('retry_index','Retry a failed source transaction with its original identity.',idSchema,true,async(a,input)=>indexing.retry(a,await metadata.active(),input.id));
  register('cancel_index','Cancel an owned source transaction and skip its ordered offset.',idSchema,true,async(a,input)=>indexing.cancel(a,await metadata.active(),input.id));
  register('materialize','Capture resolved objects and links in an atomic authorized dataset.',materializationInputSchema,true,async(a,input)=>materializations.capture(a,await metadata.active(),input));
  register('read_materialization','Read a captured dataset after current object and property authorization.',idSchema.extend({cursor:z.string().optional()}),false,async(a,input)=>materializations.read(a,await metadata.active(),input.id,input.cursor));
  register('materialized_links','Read authorized relationships from a materialization.',idSchema.extend({after:z.number().int().min(0).optional()}),false,async(a,input)=>materializations.links(a,await metadata.active(),input.id,input.after));
  register('edit_history','Read object edit history under current security policies.',z.strictObject({object:objectRefSchema,after:z.string().optional(),limit:z.number().int().min(1).max(100).optional()}),false,async(a,input)=>new EditHistory(db).read(new Objects(db,await metadata.active(),a),input.object,input.after,input.limit));
  register('edit_policy','Configure source and user edit conflict resolution.',z.strictObject({type:z.string(),policy:conflictPolicySchema}),true,async(a,input)=>setConflictPolicy(db,a,await metadata.active(),input.type,input.policy));
  register('project','Create or update a project for Ontology resource ownership.',projectSchema,true,(a,input)=>governance.project(a,input));
  register('assign_project','Assign published resources to a project.',assignProjectSchema,true,(a,input)=>governance.assign(a,input));
  register('create_branch','Create an isolated Ontology definition branch.',branchCreateSchema,true,(a,input)=>governance.create(a,input));
  register('get_branch','Inspect a definition branch and proposal.',idSchema,false,(a,input)=>governance.read(a,input.id));
  register('list_branches','List accessible Ontology branches.',ontology,false,(a,input)=>governance.list(a,input.ontology));
  register('update_branch','Update a branch at its expected revision.',branchUpdateSchema,true,(a,input)=>governance.update(a,input));
  register('prepare_branch','Validate branch bindings and prepare a candidate projection.',branchRevisionSchema,true,(a,input)=>governance.prepare(a,input));
  register('review_branch','Approve the exact candidate publication for a branch.',branchReviewSchema,true,(a,input)=>governance.review(a,input));
  register('merge_branch','Activate a reviewed candidate publication atomically.',branchReviewSchema,true,(a,input)=>governance.merge(a,input));
  register('rebase_branch','Rebase a branch onto the current Ontology definition.',branchRevisionSchema,true,(a,input)=>governance.rebase(a,input));
  register('catch_up_branch','Synchronize candidate data and require a fresh proposal review.',branchRevisionSchema,true,(a,input)=>governance.catchUp(a,input));
  register('function_versions','List registered function versions visible to this identity.',z.strictObject({}),false,async(a)=>{
    const model=await metadata.active(); return functions.versions().filter(fn=>a.canDefine(model,'function',fn.name));
  });
  register('effect_status','Read Action effect delivery state.',z.strictObject({requestId:z.string().min(1).max(128)}),false,(a,input)=>effects.status(a,input.requestId));
  register('retry_effect','Retry a failed Action effect using its stable idempotency key.',z.strictObject({id:z.string().regex(/^[a-f0-9]{64}$/)}),true,(a,input)=>effects.retry(a,input.id));
  return services;
}
