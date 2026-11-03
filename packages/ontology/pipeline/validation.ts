import {z} from 'zod';
import {digest} from '../../core/delegation.js';
import {DomainError,type Job} from '../../core/domain.js';
import type {ActionIntent} from '../actions.js';
import type {OntologyDocument} from '../definition-contracts.js';
import type {OntologyModel} from '../model.js';
import {actionEffects} from '../composition-contract.js';
import {BACKEND_VERSION} from '../execution.js';
import {mapPipelineFields} from './mapping.js';
import {pipelineMappingDigest,type PipelineIntake,type PipelineVerification} from './contracts.js';
const fail=(message:string):never=>{throw new DomainError('CONFLICT',message);};
const instant=z.iso.datetime({offset:true});
type IntakeRef=NonNullable<OntologyDocument['pipeline']>[number];

/** Storage-free definition and evidence validation shared by both adapters.
 * The caller loads the actual original task/intents and current history.
 * Neither synthetic validation nor a verification result grants authority. */
export function pipelineContract(model: OntologyModel, intake: PipelineIntake): string {
    const links = [...new Set(intake.mappings.flatMap(mapping => mapping.links?.map(link => link.linkType) ?? []))].sort();
    return digest({ actions: intake.actions.map(action => ({ id: action.actionId, definition: model.action(action.actionId) })),
      ...(links.length ? { links: links.map(id => model.link(id)) } : {}),
      types: [...new Set([...intake.mappings.map(mapping => mapping.objectType), ...intake.vocabulary.map(term => term.objectType)])].sort().map(type => ({ type, fingerprint: model.fingerprint(type) })) });
  }
export function pipelineContractIssues(model: OntologyModel, intake: PipelineIntake): string[] {
    const issues: string[] = [];
    try {
      pipelineContract(model, intake);
      for (const entry of intake.actions) {
        const action = model.action(entry.actionId), effects = actionEffects(action);
        if (digest(action) !== entry.definitionDigest) issues.push(`Action ${entry.actionId} differs from the pinned definition`);
        if (entry.requiredEvidence !== 'definition_only' && action.operation && action.operation.environment !== 'local'
          && (action.operation.environment === 'sandbox') !== (intake.environment === 'sandbox')) issues.push(`Action ${entry.actionId} has a different execution environment`);
        if (entry.requiredEvidence === 'live_readonly' && effects.some(effect => !['read', 'local'].includes(effect))) issues.push(`Read-only evidence cannot enable ${entry.actionId}`);
        if (effects.some(effect => !['read', 'local', 'object_write'].includes(effect)) && entry.requiredEvidence !== 'definition_only' && !entry.readbackActionId) issues.push(`Business action ${entry.actionId} needs an independent readback action`);
        if (entry.readbackActionId && (entry.readbackActionId === entry.actionId || actionEffects(model.action(entry.readbackActionId)).some(effect => effect !== 'read'))) issues.push(`Invalid independent readback for ${entry.actionId}`);
        if (entry.requiredEvidence !== 'definition_only' && entry.readbackActionId && intake.actions.find(action => action.actionId === entry.readbackActionId)?.requiredEvidence === 'definition_only') issues.push(`Readback for ${entry.actionId} must also be eligible for execution`);
      }
      for (const mapping of intake.mappings) {
        const type = model.object(mapping.objectType);
        for (const item of mapping.links ?? []) {
          const target = intake.mappings.find(value => value.id === item.targetMapping), link = model.link(item.linkType);
          if (!target || model.linkWritePolicy(item.linkType) !== 'source' || !model.implements(mapping.objectType, link.from.type)
            || !model.implements(target.objectType, link.to.type) || item.many && !link.from.many) issues.push(`Mapping ${mapping.id} has an incompatible relationship ${item.linkType}`);
        }
        if (mapping.fields.some(field => field.to[0] === type.primaryKey || !type.properties[field.to[0]!])) issues.push(`Mapping ${mapping.id} targets an unknown field or source identity`);
        const cases = intake.fixtures.filter(fixture => fixture.mappingId === mapping.id);
        if (!cases.length) issues.push(`Mapping ${mapping.id} has no synthetic contract examples`);
        for (const fixture of cases) {
          const mapped = mapPipelineFields(mapping, fixture.input);
          if (digest(mapped) !== digest(fixture.expected)) issues.push(`Mapping ${mapping.id} differs from its expected contract`);
          model.parseProperties(mapping.objectType, { ...mapped, [type.primaryKey]: 'pipeline:contract-test' });
        }
      }
    } catch (error) { issues.push(error instanceof Error ? error.message : 'Invalid pipeline contract'); }
    return issues;
  }

export function assertPipelineVerificationExpiry(expiresAt: string, verifiedAt: number, now:()=>number): void {
    instant.parse(expiresAt);
    if (!Number.isFinite(verifiedAt) || verifiedAt > now() || Date.parse(expiresAt) <= now() || Date.parse(expiresAt) > verifiedAt + 86400000) fail('Verification expiry must be future and within 24 hours of the actual verification');
  }

export function pipelineTaskVerification(ontologyId:string,owner:string,ref:IntakeRef,model:OntologyModel,intake:PipelineIntake,job:Job,
  intent:(id:string)=>ActionIntent,expiresAt:string,now:()=>number,anchored:boolean):PipelineVerification {
      const d = job.delegation, state = d?.agent, outcome = d?.outcome;
      const issues = pipelineContractIssues(model, intake); if (issues.length) fail(issues.join('; '));
      if (d?.backendVersion !== BACKEND_VERSION || job.state !== 'completed' || d.acceptance?.accepted !== true || outcome?.status !== 'satisfied' || !outcome.evidenceRefs.length || !state || state.composition || state.components
        || digest(state.programRef) !== digest(intake.programRef) || state.programDigest !== intake.configurationDigest) fail('Verification needs a completed independent task for this exact program and configuration');
      if (intake.environment === 'sandbox' ? d!.request.executionEnvironment !== 'sandbox' : d!.request.executionEnvironment === 'sandbox') fail('Verification task environment does not match the intake');
      const verifiedAt = outcome!.assessedAt;
      if (d!.pipelineValidation && (d!.pipelineValidation.mappingDigest !== pipelineMappingDigest(intake) || d!.pipelineValidation.requestRevision !== d!.request.revision
        || d!.pipelineValidation.ownerDigest !== digest(owner) || Date.parse(verifiedAt) > Date.parse(d!.pipelineValidation.expiresAt))) fail('Validation task belongs to another mapping, revision or time window');
      if (Date.parse(intake.source.observedAt) > Date.parse(verifiedAt)) fail('Execution predates the intake source contract');
      if (anchored) fail('This task already verified a different source or mapping; obtain new execution evidence');
      assertPipelineVerificationExpiry(expiresAt, Date.parse(verifiedAt),now);
      const actionEvidence: NonNullable<PipelineVerification['actionEvidence']> = {};
      for (const entry of intake.actions) {
        const matched = state!.plans.filter(plan => plan.requestRevision === d!.request.revision).flatMap(plan => plan.steps.filter(step => step.action === entry.actionId && step.definitionDigest === entry.definitionDigest).map(step => ({ plan, step }))).at(-1);
        if (!matched) continue;
        const actual = intent(matched.step.intentId), result = actual.lastVerifiedResult;
        if (actual.jobId !== job.id || actual.owner !== owner || actual.state !== 'effect_confirmed' || result?.kind !== 'confirmed' || !result.evidenceRefs.length || actual.planDigest !== matched.plan.digest) continue;
        const source = result.output?.source as { evidenceLevel?: unknown; evidenceKind?: unknown; observedAt?: unknown;
          receipt?: { evidenceKind?: unknown; receivedAt?: unknown; observedAt?: unknown } } | undefined;
        // Accepted programs use either a direct level (participant sources), a
        // direct kind (DiDi), or a receipt kind (Meituan). Conflicting signals
        // are not evidence, and a task-wide live label never fills a gap.
        const levels = [source?.evidenceLevel, source?.evidenceKind, source?.receipt?.evidenceKind]
          .filter(value => value !== undefined).map(value => value === 'fixture' ? 'synthetic' : value === 'provider_mock' ? 'provider_test' : value);
        const level = levels.length ? levels.every(value => value === levels[0]) ? levels[0] : undefined
          : intake.environment === 'sandbox' && outcome!.evidenceLevel === 'synthetic' ? 'synthetic'
          : intake.environment === 'local' && outcome!.evidenceLevel === 'local_test' ? 'local_test' : undefined;
        if (typeof level !== 'string' || !['synthetic', 'local_test', 'live_readonly', 'live_operation', 'live_fulfillment'].includes(level)) continue;
        if (intake.environment === 'live' ? !level.startsWith('live_') : intake.environment === 'sandbox' ? level !== 'synthetic' : !['local_test', 'synthetic'].includes(level)) continue;
        const observations = [source?.receipt?.observedAt, source?.receipt?.receivedAt, source?.observedAt].filter((value): value is string => typeof value === 'string');
        observations.forEach(value => instant.parse(value));
        const observedAt = observations.length ? new Date(Math.min(...observations.map(value => Date.parse(value)))).toISOString() : actual.createdAt;
        instant.parse(observedAt); assertPipelineVerificationExpiry(expiresAt, Date.parse(observedAt),now);
        actionEvidence[entry.actionId] = { level, evidenceRefs: [...result.evidenceRefs], observedAt };
      }
      const actionIds = Object.keys(actionEvidence);
      if (!actionIds.length) fail('Task contains no verified matching action');
      const level = outcome!.evidenceLevel ?? 'unverified';
      if (!['synthetic', 'local_test', 'live_readonly', 'live_operation', 'live_fulfillment'].includes(level)) fail('Task evidence has no admissible execution validation level');
      if (intake.environment === 'live' ? !level.startsWith('live_') : !['synthetic', 'local_test'].includes(level)) fail('Synthetic and live verification cannot be substituted');
      const verification: PipelineVerification = { id: digest({ ontologyId, owner, intake: ref.intakeDigest, task: job.id, outcome, actionIds, expiresAt }), intakeDigest: ref.intakeDigest,
        mappingDigest: pipelineMappingDigest(intake), contractDigest: pipelineContract(model, intake), kind: 'task_evidence', level, actionIds, actionEvidence,
        evidenceRefs: [...outcome!.evidenceRefs], taskId: job.id, verifiedAt, expiresAt, availabilityProof: false, authorizationProof: false };
      return verification;
}
