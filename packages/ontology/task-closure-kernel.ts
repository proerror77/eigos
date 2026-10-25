import { callerOutcomeProofSchema } from './caller-outcome-proof.js';
import { capabilityVerificationHistorySchema } from './capability-feedback.js';
import { refSchema } from './execution.js';
import { inputReferenceSchema } from './dataflow-contract.js';
import { z } from 'zod';
import type { OntologyDocument } from './definition-contracts.js';
import type { TrustedDefinitionRegistry } from './model-compiler.js';
import type { ModelDefinition, PropertyDefinition } from './model.js';
import { composable } from './composition-kernel.js';
import { executionReferenceLinks } from './execution-model.js';
import { rideEstimateActions, rideEstimateFunctions } from './ride-estimate.js';
import { orderTestActions } from './didi-order-test.js';
import { compositionActions } from './composition.js';

/** Add current closure contracts without changing any published predecessor. */
export function extendTaskClosureKernel(original: OntologyDocument, registry: TrustedDefinitionRegistry, current: ModelDefinition): OntologyDocument {
  const document = structuredClone(original); document.version = '22';
  const property = (type: string, name: string, value: PropertyDefinition) => {
    const { schema: validator, schemaMetadata: _metadata, ...metadata } = value;
    const schema = value.schemaMetadata ?? z.toJSONSchema(validator);
    return { ...metadata, schema, validatorRef: registry.registerValidator(`eigos.business:object:${type}:${name}`, 'eigos-task-closure-v22', validator, schema) };
  };
  const existing = new Set(document.objects.map(type => type.id));
  const additions = current.objects.filter(type => !existing.has(type.id));
  for (const type of additions) document.objects.push({ ...type, resourceId: `builtin:eigos.business:object:${type.id}`, writePolicy: 'source', properties: Object.fromEntries(Object.entries(type.properties).map(([name, value]) => [name, property(type.id, name, value)])) });
  for (const [id, names] of [['ServiceRequest', ['currentAssessment']], ['OutcomeAssessment', ['evidenceRefs', 'evidenceLevel', 'taskState']]] as const) {
    const source = current.objects.find(type => type.id === id)!, target = document.objects.find(type => type.id === id)!;
    target.version = source.version;
    for (const name of names) target.properties[name] = property(id, name, source.properties[name]!);
  }
  const requestSpecification = document.objects.find(type => type.id === 'RequestSpecification')!;
  requestSpecification.version = '3';
  requestSpecification.properties.capabilityRef = property(requestSpecification.id, 'capabilityRef', { kind: 'struct', schema: refSchema, description: 'Authenticated PA capability hint, never execution authority', source: 'Original request submission', required: false });
  const executionInput = document.objects.find(type => type.id === 'ExecutionInput')!;
  executionInput.version = '4';
  executionInput.properties.sourceComputation = property(executionInput.id, 'sourceComputation', { kind: 'struct', schema: inputReferenceSchema.shape.compute.unwrap(), description: 'Exact model-selected registered function and result path for a deferred input; no executable expressions', source: 'Sealed action input reference', required: false });
  const capability = document.objects.find(type => type.id === 'RegisteredCapability')!;
  capability.version = '4';
  capability.properties.contextRequestId = property(capability.id, 'contextRequestId', {kind:'string',schema:z.string().min(1).max(200),description:'Owning request for a feedback snapshot; absent on reusable definition-only records',source:'Authenticated task identity',required:false});
  capability.properties.verificationHistory = property(capability.id, 'verificationHistory', {kind:'struct',schema:capabilityVerificationHistorySchema,description:'Bounded same-owner and exact-binding aggregate feedback; not availability evidence or execution authority',source:'Authorized private outcome aggregation',required:false});
  capability.properties.scopeReviewMode = property(capability.id, 'scopeReviewMode', { kind: 'string', schema: z.literal('registered_fixed_input'), description: 'Explicitly pinned registered literal scope may use independent compact goal review', source: 'Trusted configured capability definition', required: false });
  const assessment = document.objects.find(type=>type.id==='OutcomeAssessment')!;
  assessment.version='3';
  assessment.properties.callerProof=property(assessment.id,'callerProof',{kind:'struct',schema:callerOutcomeProofSchema,description:'Typed authenticated caller contract and verified managed readback; no model coverage or fresh authority is implied',source:'Verified caller ledger and original execution evidence',required:false});
  document.links.push({id:'AssessmentCallerPlan',resourceId:'builtin:eigos.business:link:AssessmentCallerPlan',description:'Historical caller-managed assessment binds its exact independently verified execution plan',writePolicy:'source',from:{type:'OutcomeAssessment',name:'callerPlan',many:false},to:{type:'ExecutionPlan',name:'callerAssessments',many:true}});
  const knownLinks = new Set(document.links.map(link => link.id));
  for (const link of current.links) if (!knownLinks.has(link.id)) { document.links.push({ ...link, resourceId: `builtin:eigos.business:link:${link.id}`, writePolicy: 'source' }); knownLinks.add(link.id); }
  const evidenceTypes = new Set(document.objects.filter(type => type.interfaces?.some(value => value.id === 'EvidenceBacked')).map(type => type.id));
  for (const value of [...rideEstimateActions, ...orderTestActions, ...compositionActions]) {
    const action = composable(value, evidenceTypes);
    const serialized = { ...action, resourceId: `builtin:eigos.business:action:${action.id}`, implementation: { kind: 'trusted' as const, handlerRef: registry.registerAction(action) } };
    const index = document.actions.findIndex(item => item.id === action.id);
    if (index < 0) document.actions.push(serialized); else document.actions[index] = serialized;
  }
  const functions = new Map(document.functions.map(fn => [fn.id, fn]));
  for (const fn of [...current.functions.filter(fn => !functions.has(fn.id)), ...rideEstimateFunctions]) functions.set(fn.id, { ...fn, handlerRef: registry.registerFunction(fn) });
  document.functions = [...functions.values()];
  for (const link of executionReferenceLinks(document.objects, document.actions, document.interfaces)) if (!knownLinks.has(link.id)) { document.links.push({ ...link, resourceId: `builtin:eigos.business:link:${link.id}`, writePolicy: 'source' }); knownLinks.add(link.id); }
  return document;
}
