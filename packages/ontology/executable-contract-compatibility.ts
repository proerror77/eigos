import type { OntologyModel } from './model.js';
import { compiledOntologyDocumentDigest } from './model-compiler.js';
import { resolveFunctionRuntime } from './function-runtime.js';
import { builtinFunctionImplementation } from './builtin-function-implementations.js';
import { digest } from '../core/delegation.js';
import { FUNCTION_CONTRACT_CLOSEOUT_MODEL_REF, FUNCTION_CONTRACT_CLOSEOUT_DOCUMENT_DIGEST } from './function-contract-closeout-compatibility.js';

export const EXECUTABLE_CONTRACT_KERNEL_MODEL_REF = Object.freeze({ id: 'eigos.business', version: '34', digest: 'ec1f188fde14f8aff144d78eda632ae0f2464ea86374f4bebfd157c40da208c3' });
const executableDocumentDigest = 'f0ba7a406667d4563d0b9fe4136d95dfc0c9a55845db62eb08d7967d9b5f6fd2';
const descriptions = Object.freeze({ id: 'eigos.business', version: '28', digest: '04606f93dc6cfd9045ac6b9a0c3dcfa4c8f330689ecbdd3cdfa7556df15202c5' });
const reviewedPredecessors: Readonly<Record<string, string>> = {
  '28': descriptions.digest,
  '29': '3061fa84b2606d1726b9673053e5940daa141bfd84a7ba7b877a8b17ca81a8b6',
  '30': '1ef0be3f87514a7916635b3e26eec05a552fccb1df17ab1d09700baf3fe26aaf',
  '31': '2eb7c0911c04c38bb0cc0f8316c12d86318f8612f675506436b41d871ce66f51',
  '32': '53bdaa43dd60980322180e1a9aafa52a8669056aeef245fd9fc983a7a5322e04',
  '33': '5a721eaa695d262725ad3d515c3ff8e098d0858011e55ca4e3a31e84bc6b08a0',
};
const reviewedDocuments: Readonly<Record<string, string>> = {
  '28': '4cd60967a5d2332ecc70b4b862b1ada2cce2274bdca6df943c7ef5d71e00d426',
  '29': '21cf5bc03aab7e53a3deee79767b09c2f1a9e9b0e14c150f3a2c522a41750781',
  '30': '9bb94c77d123fb4fc3183da45691e94c0ef46390f19c713b2ee03500cda8d356',
  '31': 'd80ca32c702ab2fc670d6e7e85d06edc7eefac89b406e91d1266729c10132816',
  '32': '87d13ceff32c5f6bea574b5b19fb4b5d7577398b62bf0cf6bc4dab2125791e34',
  '33': '619f293031d1972f41a84f56eb49f9c23f1102443c7eaf1f71e2ab1f5f37479b',
};
const checkedFunctions = new WeakMap<OntologyModel, boolean>();
function installedFunctions(model: OntologyModel): boolean {
  const previous = checkedFunctions.get(model); if (previous !== undefined) return previous;
  const valid = model.functionIds().every(id => {
    const fn = model.function(id), binding = resolveFunctionRuntime(model, id);
    if (!binding) return !fn.executionContract;
    let expected;
    try { expected = builtinFunctionImplementation(fn); } catch { return false; }
    const actual = binding.implementation;
    return actual.execute === expected.execute && actual.input === expected.input && actual.value === expected.value
      && digest(actual.contract) === digest(expected.contract);
  });
  checkedFunctions.set(model, valid); return valid;
}
/** Public digests exclude compiler-private handler bindings. Require a genuine
 * completed compilation of the exact document (including Action handlerRefs),
 * plus the actual installed Function executors before reusing policy. */
export function reviewedExecutableRuntime(model: OntologyModel): boolean {
  const ref = model.ref.version === '35' ? FUNCTION_CONTRACT_CLOSEOUT_MODEL_REF : model.ref.version === '34' ? EXECUTABLE_CONTRACT_KERNEL_MODEL_REF : undefined;
  const document = model.ref.version === '35' ? FUNCTION_CONTRACT_CLOSEOUT_DOCUMENT_DIGEST : executableDocumentDigest;
  return !!ref && model.ref.id === ref.id && model.ref.digest === ref.digest && compiledOntologyDocumentDigest(model) === document && installedFunctions(model);
}
/** Only fields/projections reuse v28 policy. Functions remain selected by the
 * task release and require that release's explicit current invocation role. */
export function executableFieldPolicyRef(model: OntologyModel) { return reviewedExecutableRuntime(model) ? descriptions : model.ref; }
/** Installed software may read these exact old/new contracts together. This is
 * neither a migration nor a claim that v1/v2 logic is interchangeable: each task
 * keeps its own function definitions and exact executable bindings. The optional
 * v29 semantic function stays present only in tasks pinned to that branch. */
export function reviewedExecutableModelPair(left: OntologyModel, right: OntologyModel): boolean {
  const leftReviewed = reviewedExecutableRuntime(left), rightReviewed = reviewedExecutableRuntime(right);
  if (leftReviewed && rightReviewed) return true;
  const prior = leftReviewed ? right : rightReviewed ? left : undefined;
  return !!prior && prior.ref.id === descriptions.id && reviewedPredecessors[prior.ref.version] === prior.ref.digest
    && compiledOntologyDocumentDigest(prior) === reviewedDocuments[prior.ref.version] && installedFunctions(prior);
}
