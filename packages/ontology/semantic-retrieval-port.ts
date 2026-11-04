import type {Principal} from '../core/domain.js';
import type {ReadBudget} from './object-store.js';
import type {Computation} from './object-functions.js';
import type {SemanticCandidatesCall} from './semantic-retrieval.js';

/** A semantic storage operation, not raw graph access or a portable grant. */
export interface SemanticRetrievalStorage {
  semanticCandidates?(owner:string,input:SemanticCandidatesCall,budget:ReadBudget):Computation|Promise<Computation>;
}
export interface OntologyVectorPort {
  sync(principal:Principal,input:unknown):Promise<{version:1;batchId:string;batchDigest:string;rows:number;status:'indexed'}>;
}
