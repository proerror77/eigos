import { sameRef, type ExecutionCatalog } from '../core/catalog.js';
import { DomainError } from '../core/domain.js';
import type { Ref, ServiceCapability } from '../ontology/execution.js';
import { paotuiActionIds, paotuiAgentActions } from '../ontology/paotui-agent.js';

export const networkCandidateTypes = ['DeliveryQuote', 'ProductOffer', 'RideOption', 'VehicleOption'] as const;
export type NetworkCandidateType = typeof networkCandidateTypes[number];
export interface NetworkCandidatePolicy {
  capabilityRef: Ref; ontologyRef: Ref; candidateType: NetworkCandidateType;
  status: 'registered' | 'unavailable'; reason: string;
  actions: { id: string; version: string; effect: string }[];
}
// Exact trusted contracts, not seller/model labels. Recognizing a domain type
// never installs a binding, relaxes owner admission, or permits business writes.
export const networkCandidatePolicies: readonly NetworkCandidatePolicy[] = [
  { capabilityRef: { id: 'delivery.quote', version: '1' }, ontologyRef: { id: 'locations-and-parcel-quotes', version: '1' }, candidateType: 'DeliveryQuote', status: 'registered', reason: 'Registered delivery quote read policy; owner, binding, source and exact terms still require validation.', actions: [{ id: 'delivery.quote.read', version: '1', effect: 'read' }] },
  { capabilityRef: { id: 'delivery.quote', version: '2' }, ontologyRef: { id: 'saved-address-delivery-quote', version: '1' }, candidateType: 'DeliveryQuote', status: 'registered', reason: 'Registered saved-address quote read policy; owner, binding, source and exact terms still require validation.', actions: [{ id: 'delivery.quote.read', version: '2', effect: 'read' }] },
  { capabilityRef: { id: 'delivery.quote', version: '4' }, ontologyRef: { id: 'paotui.agent.actions', version: '2' }, candidateType: 'DeliveryQuote', status: 'registered', reason: 'Registered read-only delivery agent policy; each member still needs its own admitted source.', actions: paotuiActionIds.map(id => ({ id, version: paotuiAgentActions.find(a => a.id === id)!.read!.version, effect: 'read' })) },
  { capabilityRef: { id: 'commerce.catalog.query', version: '2' }, ontologyRef: { id: 'catalog.agent.actions', version: '1' }, candidateType: 'ProductOffer', status: 'unavailable', reason: 'Catalog observations are modelled, but no member-network quote-only listing binding is registered. Display prices do not establish complete purchasing terms.', actions: [] },
  { capabilityRef: { id: 'service.ride.sandbox', version: '2' }, ontologyRef: { id: 'eigos.ride', version: '2' }, candidateType: 'RideOption', status: 'unavailable', reason: 'Ride candidates are modelled; the current binding is a sandbox order operation, not an admitted network quote-only read source.', actions: [] },
  { capabilityRef: { id: 'service.vehicle.sandbox', version: '2' }, ontologyRef: { id: 'eigos.vehicle', version: '2' }, candidateType: 'VehicleOption', status: 'unavailable', reason: 'Reserved-ride and rental candidates are modelled; the current binding is a sandbox reservation operation, not an admitted network quote-only read source.', actions: [] },
];
export function networkCandidatePolicy(ref: Ref): NetworkCandidatePolicy | undefined {
  const policy = networkCandidatePolicies.find(p => sameRef(p.capabilityRef, ref));
  return policy && structuredClone(policy);
}
export function validateQuoteCapability(capability: ServiceCapability): ServiceCapability {
  const policy = networkCandidatePolicy(capability.ref);
  if (!policy || policy.status !== 'registered') throw new DomainError('FORBIDDEN', policy?.reason ?? 'No exact registered quote-only policy for this capability version');
  if (capability.environment === 'sandbox' || !sameRef(capability.ontologyRef, policy.ontologyRef)
    || capability.actions.length !== policy.actions.length
    || !policy.actions.every(action => capability.actions.filter(a => a.ref.id === action.id && a.ref.version === action.version && a.effect === action.effect).length === 1))
    throw new DomainError('FORBIDDEN', 'Capability definition does not match the exact registered quote-only policy');
  return capability;
}
export function assertCandidateSelectionPolicy(catalog: ExecutionCatalog, capabilityRef: Ref, candidateType: NetworkCandidateType): void {
  const policy = networkCandidatePolicy(capabilityRef);
  if (!policy || policy.status !== 'registered' || policy.candidateType !== candidateType)
    throw new DomainError('FORBIDDEN', policy?.candidateType === candidateType ? policy.reason : 'Selected candidate type has no admitted quote-only binding for this inquiry');
  validateQuoteCapability(catalog.capability(capabilityRef));
}
