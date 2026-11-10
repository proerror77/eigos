import type { OntologyModel } from './model.js';

export const EXECUTABLE_CONTRACT_KERNEL_MODEL_REF = Object.freeze({ id: 'eigos.business', version: '34', digest: '5ff0d80f555406770ee2a29d9838e2752533386482b79ce1699c21a85e74c458' });
const descriptions = Object.freeze({ id: 'eigos.business', version: '28', digest: '04606f93dc6cfd9045ac6b9a0c3dcfa4c8f330689ecbdd3cdfa7556df15202c5' });
const reviewedPredecessors: Readonly<Record<string, string>> = {
  '28': descriptions.digest,
  '29': '3061fa84b2606d1726b9673053e5940daa141bfd84a7ba7b877a8b17ca81a8b6',
  '30': '1ef0be3f87514a7916635b3e26eec05a552fccb1df17ab1d09700baf3fe26aaf',
  '31': '2eb7c0911c04c38bb0cc0f8316c12d86318f8612f675506436b41d871ce66f51',
  '32': '53bdaa43dd60980322180e1a9aafa52a8669056aeef245fd9fc983a7a5322e04',
  '33': '5a721eaa695d262725ad3d515c3ff8e098d0858011e55ca4e3a31e84bc6b08a0',
};
const exact = (model: OntologyModel) => model.ref.id === EXECUTABLE_CONTRACT_KERNEL_MODEL_REF.id && model.ref.version === '34' && model.ref.digest === EXECUTABLE_CONTRACT_KERNEL_MODEL_REF.digest;
/** Only fields/projections reuse v28 policy. Functions remain selected by the
 * task release and require that release's explicit current invocation role. */
export function executableFieldPolicyRef(model: OntologyModel) { return exact(model) ? descriptions : model.ref; }
/** Installed software may read these exact old/new contracts together. This is
 * neither a migration nor a claim that v1/v2 logic is interchangeable: each task
 * keeps its own function definitions and exact executable bindings. The optional
 * v29 semantic function stays present only in tasks pinned to that branch. */
export function reviewedExecutableModelPair(left: OntologyModel, right: OntologyModel): boolean {
  const prior = exact(left) ? right : exact(right) ? left : undefined;
  return !!prior && prior.ref.id === descriptions.id && reviewedPredecessors[prior.ref.version] === prior.ref.digest;
}
