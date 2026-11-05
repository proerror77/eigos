import { SINGLE_READ_KERNEL_MODEL_REF, PAYMENT_COMMERCE_KERNEL_MODEL_REF } from '../ontology/seed-definition.js';
import type { OntologyModel } from '../ontology/model.js';
import { digest } from '../core/delegation.js';
import { SINGLE_READ_PREDECESSOR, PRIOR_GOAL_COVERAGE_FINGERPRINT } from '../ontology/single-read-kernel.js';
import { SecurityError } from './errors.js';
import {semanticFieldPolicyRef,isSemanticRetrievalSuccessor} from '../ontology/semantic-retrieval-kernel.js';

/** Exact reviewed historical kernel compatibility; never grants data access. */
export function assertReviewedModel(current: OntologyModel, model: OntologyModel): void {
  if (current === model) return;
  if(current.ref.id==='eigos.business'&&current.ref.version==='30'&&current.ref.digest==='c7a8273844d891f98cd83ccc41c48ce156e9c5e9aef5b6e46490f8d9047b781d'&&['28','29'].includes(model.ref.version)&&semanticFieldPolicyRef(model).id==='eigos.business'&&semanticFieldPolicyRef(model).version==='28'&&semanticFieldPolicyRef(model).digest==='04606f93dc6cfd9045ac6b9a0c3dcfa4c8f330689ecbdd3cdfa7556df15202c5'){
    const a=model.definitionSnapshot(),b=current.definitionSnapshot();if(a.objects.every(t=>current.hasType(t.id)&&model.fingerprint(t.id)===current.fingerprint(t.id))&&a.links.every(l=>digest(l)===digest(current.link(l.id)))&&a.actions.every(x=>digest(x)===digest(current.action(x.id)))&&a.functions.every(x=>b.functions.some(y=>digest(x)===digest(y))))return;
  }
  if(isSemanticRetrievalSuccessor(model,current)||isSemanticRetrievalSuccessor(current,model))return;
  // Reviewed v22 -> RollingGo-only v23 compatibility. Historical tasks keep
  // their own model and action bindings; current data/source grants still gate reads.
  if ((current.ref.digest === '2c39527a5973ae4b09b402f382ef192d13f1fca0f5cf3424bcd410b8c3c0a127' || ['24','25','26','27','28','29','30'].includes(current.ref.version))
    && model.ref.id === current.ref.id && ['b800ef526f90c2dfbbb6c82495318bf820145520ce2dd1d63635c8b930c5fca4', '2c39527a5973ae4b09b402f382ef192d13f1fca0f5cf3424bcd410b8c3c0a127', '496938a2cf4a6661acab90171d6c3988c890364dee7d4f62c3575b2e2c70d644', SINGLE_READ_PREDECESSOR, SINGLE_READ_KERNEL_MODEL_REF.digest, PAYMENT_COMMERCE_KERNEL_MODEL_REF.digest].includes(model.ref.digest)
    && model.definitionSnapshot().objects.every(type => current.hasType(type.id) && (model.fingerprint(type.id) === current.fingerprint(type.id)
      || current.hasType('Person') && type.id === 'RequestFact' && model.fingerprint(type.id) === 'aca8fe3bad913ec40620004cfaf77e1620dbd40d6f59d92a774fc90aca9e1ace'
      || ['26','27','28','29','30'].includes(current.ref.version) && type.id === 'GoalCoverage' && model.fingerprint(type.id) === PRIOR_GOAL_COVERAGE_FINGERPRINT))
    && model.definitionSnapshot().links.every(link => digest(link) === digest(current.link(link.id)))
    && model.definitionSnapshot().functions.every(fn => digest(fn) === digest(current.function(fn.id)))
    && model.actionIds().every(id => digest(model.actionImplementation(id) ?? null) === digest(current.actionImplementation(id) ?? null))) {
    return;
  }
  if (model.ref.id !== current.ref.id || model.ref.digest !== current.ref.digest
    || model.actionIds().some(id => digest(model.actionImplementation(id) ?? null) !== digest(current.actionImplementation(id) ?? null))) throw new SecurityError('POLICY_CHANGED');
}
