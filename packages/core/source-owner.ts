import {ownerIdentitySchema} from '../security/contracts.js';

const localOwner=JSON.stringify(['local-development','local','developer']);
const owners=new WeakMap<object,string>();
/** Operator configuration binds this one existing personal connector to one
 * verified owner partition. It grants neither source operations nor task data. */
export function bindPersonalSourceOwner(program:object,owner:string) {
  const canonical=ownerIdentitySchema.parse(owner),previous=owners.get(program);
  if(previous && previous!==canonical)throw new Error('A source owner binding is immutable for this process');
  owners.set(program,canonical);
}
export function permitsPersonalSource(program:object,owner:string) {return owner===(owners.get(program)??localOwner);}
