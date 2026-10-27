import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { AgentActionContext, AgentActionResult, AgentProgram, AgentProgramContext } from '../core/agent-program.js';
import type { JobStore } from '../core/store.js';
import type { PipelineReadTarget } from '../ontology/pipeline/observation.js';
import { mapPipelineObservation, pipelineObjectRef } from '../ontology/pipeline/mapping.js';
import { actionEffects } from '../ontology/composition-contract.js';
import { withProgramProjection } from '../security/execution.js';
import { assertPipelineReady } from '../ontology/pipeline/contracts.js';

const targetSchema = z.strictObject({ serviceId: z.string().min(1).max(240), mappingId: z.string().min(1).max(240), sourceAccount: z.string().min(1).max(240), nativeId: z.string().trim().min(1).max(500) });
const fail = (message: string): never => { throw new DomainError('CONFLICT', message); };
export function capturePipelineRead(store: JobStore, program: AgentProgram, ctx: AgentProgramContext, action: string, input: Record<string, unknown>) {
  const selected = program.pipelineTarget?.(ctx, action, input);
  if (!selected) return;
  const effects = actionEffects(program.definition(ctx.graph, action));
  if (!program.pipelineSample || program.modelCallsPerAction || !effects.length || effects.some(effect => effect !== 'read')) fail('Pipeline observation requires a reviewed model-free read-only source mapper');
  const target: PipelineReadTarget = targetSchema.parse(selected), release = ctx.graph.releaseRef ?? fail('Pipeline reads require a pinned release');
  assertPipelineReady(ctx.graph.pipelineStatus(ctx.owner, program.ref, program.configurationDigest, action));
  const published = store.definitions.resolve(release), ref = published.document.pipeline?.find(ref => ref.serviceId === target.serviceId) ?? fail('Source intake is not published');
  const intake = store.definitions.pipeline.intake(release.ontologyId, ref);
  if (digest(intake.programRef) !== digest(program.ref) || intake.configurationDigest !== program.configurationDigest
    || !intake.actions.some(value => value.actionId === action && value.definitionDigest === digest(program.definition(ctx.graph, action)))) fail('Source mapper differs from its published program/action contract');
  const active = store.definitions.active(release.ontologyId).document.pipeline?.find(value => value.serviceId === ref.serviceId);
  if (active?.intakeDigest !== ref.intakeDigest || store.definitions.pipeline.validateIntake(release.ontologyId, ref, ctx.graph.model).length) fail('Source mapping is not current');
  const mapping = intake.mappings.find(mapping => mapping.id === target.mappingId) ?? fail('Source mapping is unavailable');
  if (!program.projectionTypes?.includes(mapping.objectType)) fail('Source program has not declared this mapped output type');
  const object = pipelineObjectRef(ctx.owner, intake.source.id, target.sourceAccount, mapping.objectType, target.nativeId);
  return { target, release, intakeDigest: ref.intakeDigest, object, sourceRevision: store.pipelineFacts.current(ctx.owner, release.ontologyId, object)?.revision ?? 0 };
}
export type CapturedPipelineRead = NonNullable<ReturnType<typeof capturePipelineRead>>;
export function projectPipelineRead(store: JobStore, program: AgentProgram, ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: AgentActionResult, captured: CapturedPipelineRead) {
  store.assertTransaction();
  const current = capturePipelineRead(store, program, ctx, action, input) ?? fail('The source no longer supports this observation');
  if (digest(current.target) !== digest(captured.target) || current.intakeDigest !== captured.intakeDigest || digest(current.release) !== digest(captured.release)) fail('Source identity or mapping changed during the read');
  return withProgramProjection(program, action, () => {
    const sample = program.pipelineSample!(ctx, action, input, result);
    if (sample.sourceAccount !== captured.target.sourceAccount) fail('Source observation belongs to another account');
    const intake = store.definitions.pipeline.intake(captured.release.ontologyId, { serviceId: captured.target.serviceId, intakeDigest: captured.intakeDigest });
    const mapping = intake.mappings.find(value => value.id === captured.target.mappingId)!;
    const mapped = mapPipelineObservation(ctx.graph.model, ctx.owner, intake, mapping, sample, store.pipelineFacts.now());
    if (digest(mapped.ref) !== digest(captured.object)) fail('The source returned a different entity');
    if (!sample.independentRead) fail('A repeating observation requires independent source readback');
    const applied = store.ingestPipelineObservationInTransaction(ctx.owner, captured.release, captured.target.serviceId, captured.target.mappingId, sample, captured.sourceRevision);
    // Another task may already hold this identical canonical fact. Independently
    // reading it binds the current task without fabricating a new object version.
    if (applied.status === 'unchanged') ctx.graph.security?.recordProjection(ctx.owner, { objects: [{ ref: mapped.ref, properties: mapped.properties }], links: [] },
      { kind: sample.evidenceLevel === 'synthetic' ? 'synthetic' : 'provider', id: `pipeline:${digest({ intakeDigest: captured.intakeDigest, event: sample.eventId })}`, observedAt: sample.observedAt });
    return { ...applied, semanticDigest: mapped.semanticDigest };
  });
}
