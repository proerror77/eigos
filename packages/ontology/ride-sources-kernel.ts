import {z} from 'zod';
import {rideSourceObjects,rideSourceActions,rideSourceLinks} from './ride-sources.js';
import {composable} from './composition-kernel.js';
import {executionReferenceLinks} from './execution-model.js';
import type {OntologyDocument} from './definition-contracts.js';
import type {TrustedDefinitionRegistry} from './model-compiler.js';
/** Explicit v30 software support. Default runtime remains v28; no DB changes. */
export function extendRideSourcesKernel(original:OntologyDocument,registry:TrustedDefinitionRegistry):OntologyDocument{
 if(original.version!=='29'||original.objects.some(t=>t.id==='RideSourceTask'))throw new Error('Ride sources require the unchanged semantic v29 predecessor');
 const document=structuredClone(original);document.version='30';
 for(const type of rideSourceObjects)document.objects.push({...type,resourceId:`builtin:eigos.business:object:${type.id}`,writePolicy:'source',properties:Object.fromEntries(Object.entries(type.properties).map(([name,p])=>{const {schema:validator,...metadata}=p,schema=z.toJSONSchema(validator);return [name,{...metadata,schema,validatorRef:registry.registerValidator(`eigos.business:object:${type.id}:${name}`,'ride-sources-v30',validator,schema)}];}))});
 const evidence=new Set(document.objects.filter(t=>t.interfaces?.some(i=>i.id==='EvidenceBacked')).map(t=>t.id));
 for(const definition of rideSourceActions){const action=composable(definition,evidence);document.actions.push({...action,resourceId:`builtin:eigos.business:action:${action.id}`,implementation:{kind:'trusted',handlerRef:registry.registerAction(action)}});}
 const fn={id:'rideSourceStatus',version:'1',inputTypes:['RideSourceObservation'],description:'Verify source-proven estimate and current scope. Never infer a ride booking or payment'};
 document.functions.push({...fn,handlerRef:registry.registerFunction(fn)});
 const known=new Set(document.links.map(t=>t.id));for(const link of [...rideSourceLinks,...executionReferenceLinks(document.objects,document.actions,document.interfaces)])if(!known.has(link.id)){document.links.push({...link,resourceId:`builtin:eigos.business:link:${link.id}`,writePolicy:'source'});known.add(link.id);}return document;
}
