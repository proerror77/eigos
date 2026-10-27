import { digest } from '../../packages/core/delegation.js';
import type { AgentProgram } from '../../packages/core/agent-program.js';
import type { OntologyModel } from '../../packages/ontology/model.js';
import { parsePipelineIntake, type PipelineIntake } from '../../packages/ontology/pipeline/contracts.js';
import type { SerializableObjectType } from '../../packages/ontology/definition-contracts.js';

export function participantIntake(model: OntologyModel, program: AgentProgram): PipelineIntake {
  return parsePipelineIntake({ format: 'eigos.ontology.pipeline.v1', serviceId: 'participant.fixture',
    source: { id: 'participant.fixture', revision: '1', digest: digest('synthetic-participant-contract-v1'), observedAt: new Date(Date.now() - 60000).toISOString(), reference: 'urn:eigos:synthetic:participant-v1' },
    programRef: program.ref, configurationDigest: program.configurationDigest, environment: 'sandbox',
    vocabulary: [{ term: '活动报名', aliases: ['展览预约', '参与者报名'], objectType: 'RegistrationTask' }],
    actions: ['InspectRegistrationPage', 'SubmitFreeRegistrationSandbox', 'ReadParticipantRegistration'].map(actionId => ({ actionId, definitionDigest: digest(model.action(actionId)),
      requiredEvidence: 'synthetic', ...(actionId.startsWith('Submit') ? { readbackActionId: 'ReadParticipantRegistration' } : {}) })),
    mappings: [], fixtures: [], conditions: { regions: ['CN'], payment: 'not_required', operatorRequired: false },
  });
}
const property = (schema: Record<string, unknown>, kind: 'string' | 'timestamp' = 'string') => ({ kind, schema, description: 'Synthetic source field', source: 'Pipeline fixture', required: true });
export const pipelineEventType: SerializableObjectType = {
  resourceId: 'pipeline:test:event', id: 'PipelineEvent', version: '1', name: '活动场次', aliases: ['展览'], description: 'Source-scoped synthetic activity',
  primaryKey: 'id', titleKey: 'title', writePolicy: 'source', properties: {
    id: property({ type: 'string', minLength: 1, maxLength: 200 }), title: property({ type: 'string', minLength: 1, maxLength: 200 }),
    status: property({ type: 'string', enum: ['submitted', 'waitlisted', 'confirmed', 'unknown'] }),
    startsAt: property({ type: 'string', format: 'date-time' }, 'timestamp'), venue: property({ type: 'string', minLength: 1, maxLength: 200 }),
  },
};
/** Same concepts and output contract, two providers' different field/state names. */
export function eventIntake(model: OntologyModel, vendor: 'a' | 'b' = 'a'): PipelineIntake {
  const columns = vendor === 'a' ? ['label', 'state', 'time', 'place'] : ['event_name', 'booking_state', 'begin_at', 'venue_address'];
  const statuses = vendor === 'a' ? { applied: 'submitted', waiting: 'waitlisted', admitted: 'confirmed', missing: 'unknown' } : { request_received: 'submitted', queue: 'waitlisted', ticket_issued: 'confirmed', unavailable: 'unknown' };
  const expected = { title: '合成展览', status: 'waitlisted', startsAt: '2030-01-01T10:00:00+08:00', venue: '合成场馆 A' };
  const fixture = { native: 'same-source-id', [columns[0]!]: expected.title, [columns[1]!]: vendor === 'a' ? 'waiting' : 'queue', [columns[2]!]: expected.startsAt, [columns[3]!]: expected.venue };
  return parsePipelineIntake({ format: 'eigos.ontology.pipeline.v1', serviceId: `event.${vendor}`,
    source: { id: `event.${vendor}`, revision: '1', digest: digest({ vendor, columns, statuses }), observedAt: new Date(Date.now() - 60000).toISOString(), reference: `urn:eigos:synthetic:event-${vendor}` },
    programRef: { id: `event.${vendor}`, version: '1' }, configurationDigest: digest({ vendor }), environment: 'sandbox',
    vocabulary: [{ term: '展览报名', aliases: ['活动注册'], objectType: 'PipelineEvent' }],
    actions: [{ actionId: 'InspectRegistrationPage', definitionDigest: digest(model.action('InspectRegistrationPage')), requiredEvidence: 'definition_only' }],
    mappings: [{ id: 'event', objectType: 'PipelineEvent', nativeId: ['native'], maxAgeMs: 60000,
      fields: ['title', 'status', 'startsAt', 'venue'].map((to, index) => ({ from: [columns[index]!], to: [to], ...(to === 'status' ? { values: statuses, unknownValue: 'unknown' } : {}) })) }],
    fixtures: [{ mappingId: 'event', input: fixture, expected }], conditions: { regions: ['CN'], payment: 'not_required', operatorRequired: false },
  });
}
