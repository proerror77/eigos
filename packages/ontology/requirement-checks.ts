import { z } from 'zod';
import { moneySchema, type CandidateFacts, type RequirementCheck, type ServiceRequest } from './execution.js';
import { equivalentQuantities } from './quantity.js';

export function checkRequirements(request: ServiceRequest, facts: CandidateFacts, evidenceRefs: string[], predicates: string[] = [], locationSemantics?: 'search_area' | 'destination'): RequirementCheck[] {
  return request.requirements.map(requirement => {
    let pass: boolean | undefined;
    switch (requirement.kind) {
      case 'quantity': {
        const actual = requirement.role ? facts.quantities?.[requirement.role] : facts.quantity;
        if (actual) pass = equivalentQuantities(actual, requirement.expected)
          ?? (/^(0|[1-9]\d*)$/.test(actual.amount) ? actual.unit === requirement.expected.unit && actual.amount === requirement.expected.amount : undefined);
        break;
      }
      case 'budget': {
        const price = moneySchema.safeParse(requirement.role ? facts.amounts?.[requirement.role] : facts.totalPrice);
        if (price.success && price.data.currency === requirement.expected.currency) pass = BigInt(price.data.minor) <= BigInt(requirement.expected.minor);
        break;
      }
      case 'deadline': { const actual = requirement.role ? facts.deadlines?.[requirement.role] : facts.deliveryBy; if (actual && z.iso.datetime({ offset: true }).safeParse(actual).success) pass = Date.parse(actual) <= Date.parse(requirement.expected.at); break; }
      case 'location': {
        const actual = requirement.role ? facts.locations?.[requirement.role] : facts.locationRef;
        if (actual === requirement.expected.ref) pass = true;
        else if (!requirement.role && locationSemantics === 'search_area' && facts.searchArea) {
          const city = facts.searchArea.city.replace(/市$/, '').replace(/\s/g, ''); const keyword = facts.searchArea.keyword.replace(/\s/g, '').replace(/(?:附近|周边)(?:的)?$/, '');
          const target = requirement.expected.ref.replace(/\s/g, '').replace(/(?:附近|周边)(?:的)?$/, '');
          const original = request.originalGoal + request.messages.map(m => m.text).join('');
          const stripCity = (s: string) => s.startsWith(city) ? s.slice(city.length).replace(/^市/, '') : s;
          if (city && (target.replace(/市$/, '') === city || (stripCity(target) === stripCity(keyword) && (target.startsWith(city) || original.includes(city))))) pass = true;
        } else if (actual) pass = false;
        break;
      }
      case 'condition': if (predicates.includes(requirement.expected.predicate) && facts.conditions) pass = facts.conditions.includes(requirement.expected.predicate); break;
    }
    const result = pass === undefined || !evidenceRefs.length ? 'unknown' : pass ? 'pass' : 'fail';
    return { requirementId: requirement.id, result, reason: result === 'unknown' ? 'No compatible, evidenced fact for this requirement' : result === 'pass' ? 'Observed fact meets the fixed requirement' : 'Observed fact violates the fixed requirement', evidenceRefs: [...evidenceRefs] };
  });
}
export function hardRequirementsPass(request: ServiceRequest, checks: RequirementCheck[]): boolean {
  return request.requirements.filter(r => r.strength === 'hard').every(r => checks.find(c => c.requirementId === r.id)?.result === 'pass');
}
