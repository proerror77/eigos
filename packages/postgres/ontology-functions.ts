import type { Client } from 'pg';
import { DomainError, ownerKey, type Principal } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import type { ObjectRef } from '../ontology/model.js';
import { IncompleteRelationshipRead, type ObjectQuery, type ReadBudget, type LinkWrite } from '../ontology/object-store.js';
import { evaluateFunctionProgram, type Computation } from '../ontology/object-functions.js';
import { parseFunctionInvocation } from '../ontology/function-runtime.js';
import { runGraphProgramAsync, type GraphStorage, type ProjectionMetadata } from '../ontology/graph-program.js';
import type { StagedKernelBuilder } from '../ontology/seed-definition.js';
import { combineEnvelopes, type SecurityEnvelope } from '../security/envelope.js';
import { projectFunctionValue } from '../security/projections.js';
import { SecurityError } from '../security/errors.js';
import { secureEvaluateSchema, secureQuerySchema, secureFunctionCallSchema } from '../security/view-contracts.js';
import { postgresBusinessSchema, postgresConstrainReadDeadline } from './runtime-transaction.js';
import { postgresTaskReadOntology, postgresTaskResourceViewValidUntil, withPostgresTaskReadGrant } from './task-read-access.js';
import { withPostgresTaskReadAuthorization, type PostgresFunctionReadAuthorization, type PostgresTaskReadAuthorization } from './task-output.js';
import { PostgresProjectionGraph } from './projection-graph.js';
import { postgresQueryAuthorizedObjects, type PostgresOntologyCursor } from './ontology-read-query.js';
import {postgresSemanticCandidates} from './embedding-index.js';
import type {SemanticCandidatesCall} from '../ontology/semantic-retrieval.js';

const unavailable=(error:unknown)=>error instanceof SecurityError&&['AUTHORIZATION_REQUIRED','INSUFFICIENT_ACCESS','OUTPUT_NOT_ALLOWED'].includes(error.reason)
  ||error instanceof DomainError&&error.code==='NOT_FOUND';

/** A single registered calculation on one admitted SQL snapshot. This graph
 * cannot mutate business state, dispatch providers or outlive its function
 * scope. Private source bodies remain inside trusted validation programs. */
class FunctionGraph implements GraphStorage,ProjectionMetadata {
  readonly security=true;
  readonly now=Date.now;
  readonly model;
  readonly releaseRef;
  private readonly owner:string;
  private readonly cursors=new Map<string,PostgresOntologyCursor>();
  private readonly envelopes=new Map<string,SecurityEnvelope>();
  constructor(private readonly client:Client,private readonly principal:Principal,private readonly taskId:string,
    private readonly revision:number,private readonly policy:string,private readonly auth:PostgresFunctionReadAuthorization,
    private readonly graph:PostgresProjectionGraph,private readonly builder?:StagedKernelBuilder){
    this.owner=ownerKey(principal);this.model=graph.model;this.releaseRef=graph.releaseRef;
  }
  private active(owner=this.owner){if(owner!==this.owner)throw new DomainError('FORBIDDEN','Calculation belongs to another owner');this.auth.integrity();}
  private charge(budget:ReadBudget){budget.remaining--;if(budget.remaining<0)throw new DomainError('CONFLICT','Ontology read work budget exhausted; narrow the query');}
  private capture=(envelope:SecurityEnvelope)=>{this.envelopes.set(digest(envelope),structuredClone(envelope));};
  async requireObject(ref:ObjectRef){
    this.active();const definition=this.model.object(ref.type);
    try {const value=await this.auth.readObject(ref,[definition.primaryKey,definition.titleKey]);this.capture(value.envelope);}
    catch(error){if(unavailable(error))throw new DomainError('NOT_FOUND','Object is not available in this task');throw error;}
  }
  async read(owner:string,ref:ObjectRef,budget:ReadBudget={remaining:1000}){
    this.active(owner);this.charge(budget);const value=await this.auth.readObject(ref);this.capture(value.envelope);return value.object;
  }
  async semanticCandidates(owner:string,input:SemanticCandidatesCall,budget:ReadBudget){
    this.active(owner);return postgresSemanticCandidates(this.client,this.principal,this.taskId,input,this.policy,this.auth,budget,this.capture,this.builder);
  }
  async readPrivate(owner:string,ref:ObjectRef,budget:ReadBudget={remaining:1000}){
    this.active(owner);this.charge(budget);return this.auth.readPrivate(ref);
  }
  async evidencePropertiesDigest(owner:string,ref:ObjectRef,budget:ReadBudget){
    this.active(owner);this.charge(budget);return this.auth.evidencePropertiesDigest(ref);
  }
  async query(owner:string,input:ObjectQuery,budget:ReadBudget={remaining:1000},readScope?:string){
    this.active(owner);
    const result=await postgresQueryAuthorizedObjects(this.client,this.principal,secureQuerySchema.parse({version:2,taskId:this.taskId,
      expectedRequestRevision:this.revision,query:input}),this.policy,this.auth,this.builder,
    {budget,readScope,cursors:this.cursors,graph:this.graph,onRead:this.capture,derive:(id,ref,nextBudget)=>
      postgresEvaluateAuthorizedFunction(this.client,this.principal,this.taskId,this.revision,{function:id,object:ref},this.policy,this.auth,this.builder,
        {budget:nextBudget,graph:this.graph,accessErrors:'throw'})});
    return result.query;
  }
  async related(owner:string,from:ObjectRef,link:string,budget:ReadBudget){
    const result=await this.query(owner,{from,link,limit:50},budget);
    if(result.page.hasMore)throw new IncompleteRelationshipRead();
    const nav=this.model.navigation(from.type,link),side=nav.direction==='forward'?'from':'to';
    const count=await this.client.query(`SELECT count(*) AS n FROM "${postgresBusinessSchema(this.client)}".ontology_links
      WHERE owner=$1 AND type=$2 AND ${side}_type=$3 AND ${side}_id=$4`,[this.owner,nav.link.id,from.type,from.id]);
    const total=Number(count.rows[0]?.n);
    if(!Number.isSafeInteger(total)||total<0)throw new DomainError('CONFLICT','Invalid relationship count');
    if(total!==result.items.length)throw new IncompleteRelationshipRead();
    return result.items;
  }
  async relationshipDigest(owner:string,ref:ObjectRef,budget:ReadBudget){
    this.active(owner);await this.requireObject(ref);
    if(this.auth.integrity())return this.graph.relationshipDigest(owner,ref,budget);
    return this.graph.relationshipDigestVisible(owner,ref,budget,async(link:LinkWrite)=>{
      const until=await postgresTaskResourceViewValidUntil(this.client,this.principal,this.taskId,this.policy,'linkType',link.type,this.builder);
      if(until<=Date.now())return false;
      postgresConstrainReadDeadline(this.client,until);
      try{await this.requireObject(link.to);return true;}catch(error){if(unavailable(error))return false;throw error;}
    });
  }
  async containsLinks(owner:string,links:LinkWrite[]){this.active(owner);return this.graph.containsLinks(owner,links);}
  ingest():never{throw new SecurityError('AUTHORIZATION_REQUIRED','Calculations cannot mutate business state');}
  tombstone():never{throw new SecurityError('AUTHORIZATION_REQUIRED','Calculations cannot inspect lifecycle metadata');}
  withGraphIntegrity<T>(action:()=>Promise<T>):Promise<T>{this.active();return this.auth.withIntegrity(action);}
  evidence(){this.active();return combineEnvelopes([...this.envelopes.values()]);}
  async authorize(){this.active();await this.auth.authorizeEvidence(this.evidence());}
}

export async function postgresEvaluateOntology(client:Client,principal:Principal,input:unknown,policy:string,builder?:StagedKernelBuilder){
  const p=structuredClone(principal),args=secureEvaluateSchema.parse(input);
  return withPostgresTaskReadAuthorization(client,p,args.taskId,policy,async auth=>{
    const read=await postgresEvaluateAuthorizedFunction(client,p,args.taskId,args.expectedRequestRevision,args.call,policy,auth,builder);
    const result={version:2,taskId:args.taskId,requestRevision:read.requestRevision,...read.computation,functionRef:read.functionRef};
    if(Buffer.byteLength(JSON.stringify(result))>64000)throw new DomainError('CONFLICT','Function response limit exceeded; narrow the investigation');
    return result;
  },builder);
}

/** Existing admitted read only. Returns influence metadata to the Worker/derived
 * view caller, never a private source body or a reusable function authority. */
export async function postgresEvaluateAuthorizedFunction(client:Client,principal:Principal,taskId:string,expectedRequestRevision:number|undefined,
  input:unknown,policy:string,auth:PostgresTaskReadAuthorization,builder?:StagedKernelBuilder,
  options:{budget?:ReadBudget;graph?:PostgresProjectionGraph;accessErrors?:'unknown'|'throw'}={}){
  const p=structuredClone(principal),basic=secureFunctionCallSchema.parse(input),owner=ownerKey(p);
  const admission=await withPostgresTaskReadGrant(client,p,taskId,policy,async value=>value);
  if(!admission.grant.operations.includes(admission.actor.actorKind==='worker'?'task.process':'task.query'))throw new SecurityError('AUTHORIZATION_REQUIRED');
  if(expectedRequestRevision!==undefined&&expectedRequestRevision!==admission.grant.requestRevision)throw new SecurityError('POLICY_CHANGED');
  return auth.withFunction(basic.function,async calculation=>{
    const ontology=await postgresTaskReadOntology(client,p,taskId,policy,builder),call=parseFunctionInvocation(ontology.model,basic);
    const definition=ontology.model.function(call.function);
    if(!definition.inputTypes.some(type=>ontology.model.implements(call.object.type,type)))throw new DomainError('INVALID_INPUT','Function requires its registered object type');
    const storage=options.graph??await PostgresProjectionGraph.create(client,owner,ontology.ref,builder,{readOnly:true});
    if(digest(storage.releaseRef)!==digest(ontology.ref))throw new SecurityError('POLICY_CHANGED');
    const graph=new FunctionGraph(client,p,taskId,admission.grant.requestRevision,policy,calculation,storage,builder);
    await graph.requireObject(call.object);
    let computation:Computation;
    try {computation=await runGraphProgramAsync(graph,evaluateFunctionProgram(graph,owner,call,options.budget??{remaining:1000}));}
    catch(error){
      if(error instanceof IncompleteRelationshipRead)computation={status:'unknown',reason:error.message,evidenceRefs:[],evidenceLevels:[]};
      else if(options.accessErrors!=='throw'&&unavailable(error))computation={status:'unknown',reason:'insufficient_access',evidenceRefs:[],evidenceLevels:[]};
      else throw error;
    }
    await graph.authorize();
    if(computation.status==='known')computation={...computation,value:projectFunctionValue(call.function,call.object.type,computation.value)};
    const functionRef={id:definition.id,version:definition.version};
    if(Buffer.byteLength(JSON.stringify({...computation,functionRef}))>64000)throw new DomainError('CONFLICT','Function response limit exceeded; narrow the investigation');
    return {computation,functionRef,envelope:graph.evidence(),requestRevision:admission.grant.requestRevision};
  });
}
