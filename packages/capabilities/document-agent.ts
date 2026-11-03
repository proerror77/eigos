import { z } from 'zod';
import { digest } from '../core/delegation.js';
import type { AgentProgram, AgentProgramContext, AgentActionContext, AgentActionResult } from '../core/agent-program.js';
import type { Executor } from './executor.js';
import type { ObjectRef } from '../ontology/model.js';
import type { OntologyObjectStore } from '../ontology/object-store.js';
import type { PlanningSnapshot } from '../ontology/planning-contract.js';
import type { ServiceCapability, ServiceRequest } from '../ontology/execution.js';
import { documentCompletionSchema, documentTaskSchema } from '../ontology/document-action.js';
import { runGraphProgram } from '../ontology/graph-program.js';
import { DOCUMENT_BINDING } from './document.js';
import { DOCUMENT_SUPPLIED_INFORMATION_ONLY, initializeDocumentProgram, assertDocumentContextProgram, documentSchema, documentDefinition,
  validateDocumentProgram, prepareDocumentInvocationProgram, buildDocumentResult, projectDocumentProgram, documentOutputPorts, completeDocumentProgram } from './document-program.js';

export class DocumentAgentProgram implements AgentProgram {
  readonly ref = { id: 'document.compose', version: '2' };
  readonly configurationDigest = digest({ program: 'document-agent-v2', executor: 'bounded-document-only', maxCalls: 6, maxSourceBytes: 64000, executionConstraints: 'supplied-information-v1' });
  readonly actionIds = ['ComposeDocument'];
  readonly completionSchema = z.toJSONSchema(documentCompletionSchema);
  readonly guidance = 'Choose accepted source citations when drafting from retrieved facts. The document is one component result; it cannot prove source research, booking, payment or fulfillment.';
  readonly modelCallsPerAction = 1;
  constructor(private executor?: Executor) {}
  permitted() { return true; }
  listingBinding() { return { ...DOCUMENT_BINDING, ref: { id: DOCUMENT_BINDING.ref.id, version: '2' }, capabilityRef: this.ref, adapterId: 'document.codex.v2', configurationDigest: this.configurationDigest }; }
  capability(): ServiceCapability {
    return { ref: this.ref, ontologyRef: { id: 'eigos.document', version: '2' }, name: '生成有来源的 Markdown 文档', description: '从原始用户请求、已确认输入和明确选定的已接受来源证据生成文档。输入仅 format=markdown；可在 ComposeDocument 动作中引用来源输出。文档不能代替引用服务的事实核验或业务完成。',
      tags: ['document', 'markdown'], environment: 'local', inputSchema: z.toJSONSchema(documentTaskSchema), ontology: { objects: ['DocumentTask', 'DocumentDraft'], evidenceBoundary: 'artifact_only' },
      actions: [{ ref: { id: 'ComposeDocument', version: '1' }, effect: 'local' }], completion: 'artifact', verifierRef: { id: 'document.accepted-citations', version: '1' },
      predicates: [{ id: 'document.markdown', description: 'Actual nonempty Markdown draft with original model receipt and current accepted citations' }, { id: 'execution.no_external_effects', description: 'Document model tools and external actions are disabled' }, { id: DOCUMENT_SUPPLIED_INFORMATION_ONLY, description: 'The task uses only supplied information and local artifacts. No provider reads, external research, sends, bookings or managed business-object writes; all task action intents must be local.' }],
      outcomePredicates: ['document.markdown'], goalOutcomes: [{ predicate: 'document.markdown', phase: 'artifact', description: 'A document artifact exists; content does not establish its underlying business claims' }],
      effectConstraints: [{ predicate: 'execution.no_external_effects', allowedEffects: ['read', 'local', 'object_write'] }, { predicate: DOCUMENT_SUPPLIED_INFORMATION_ONLY, allowedEffects: ['local'] }] };
  }
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, value: unknown, component?: { id: string; scopeKey: string }) {
    return runGraphProgram(graph,initializeDocumentProgram(this,owner,request,value,component));
  }
  assertContext(ctx:AgentProgramContext){return runGraphProgram(ctx.graph,assertDocumentContextProgram(this,ctx));}
  schema(action:string){return documentSchema(action);}
  definition(graph:OntologyObjectStore,action:string){return documentDefinition(graph,action);}
  validate(ctx:AgentProgramContext,action:string,input:Record<string,unknown>){runGraphProgram(ctx.graph,validateDocumentProgram(this,ctx,action,input));}
  async invoke(ctx:AgentActionContext,action:string,input:Record<string,unknown>,signal:AbortSignal):Promise<AgentActionResult>{
    const prepared=runGraphProgram(ctx.graph,prepareDocumentInvocationProgram(this,ctx,action,input,!!this.executor));
    // The model runs only after storage preparation returns. Async callers use
    // the same preparation/result helpers around their committed transaction.
    return buildDocumentResult(prepared,await this.executor!.run(prepared.job,signal));
  }
  project(ctx:AgentActionContext,action:string,input:Record<string,unknown>,result:AgentActionResult):ObjectRef{
    return runGraphProgram(ctx.graph,projectDocumentProgram(this,ctx,action,input,result));
  }
  projectOutputs(_ctx:AgentActionContext,_action:string,_input:Record<string,unknown>,result:AgentActionResult,object:ObjectRef){return documentOutputPorts(result,object);}
  complete(ctx:AgentProgramContext,proposal:unknown,reads:PlanningSnapshot){return runGraphProgram(ctx.graph,completeDocumentProgram(this,ctx,proposal,reads));}
}
