import {digest} from '../core/delegation.js';
import {checkedRideSnapshot} from './ride-sources.js';
import {sourceProofProgram} from './object-evidence.js';
import {graphRead,graphRelated,type GraphProgram,type ProjectionMetadata} from './graph-program.js';
import type {Computation} from './object-functions.js';
import type {ObjectRef} from './model.js';
import type {ReadBudget} from './object-store.js';
export function* evaluateRideSourceProgram(graph:ProjectionMetadata,owner:string,input:{function:string;object:ObjectRef},budget:ReadBudget):GraphProgram<Computation|undefined>{
 if(input.function!=='rideSourceStatus')return;
 const unknown=(reason:string):Computation=>({status:'unknown',reason,evidenceRefs:[input.object],evidenceLevels:[]});
 if(input.object.type!=='RideSourceObservation')return unknown('Not a ride source estimate');
 const record=yield* graphRead(owner,input.object,budget),proof=yield* sourceProofProgram(graph,owner,input.object,budget);if(!proof)return unknown('Ride source proof changed');
 let s;try{s=checkedRideSnapshot(record.properties.snapshot);}catch{return unknown('Invalid ride source snapshot');}
 const roots=yield* graphRelated(owner,input.object,'request',budget),scopes=yield* graphRelated(owner,input.object,'scope',budget),r=s.result.receipt;
 if(Date.parse(r.startedAt)>graph.now()||Date.parse(r.startedAt)+300000<=graph.now()||roots?.length!==1||roots[0]!.ref.id!==s.wire.requestId||roots[0]!.properties.revision!==s.wire.requestRevision||scopes?.length!==1||digest(scopes[0]!.ref)!==digest(s.scope)||scopes[0]!.properties.requestRevision!==s.wire.requestRevision||scopes[0]!.properties.provider!==s.result.data.provider||scopes[0]!.properties.configurationDigest!==s.wire.programDigest||digest(scopes[0]!.properties.input)!==digest(s.actionInput.query))return unknown('Ride quote expired or scope changed');
 return {status:'known',value:{provider:s.result.data.provider,estimate:s.result.data,status:'user_action_required',orderCreated:false,paymentInitiated:false},evidenceRefs:[input.object,...proof.refs],evidenceLevels:proof.levels};
}
