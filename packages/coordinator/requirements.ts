import { z } from 'zod';
import { DomainError } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import { requirementSchema, type ServiceRequest, type RequirementRoleDefinition } from '../ontology/execution.js';
import { quantityAppearsInQuote } from '../ontology/quantity.js';
import { operativeText } from '../core/current-inputs.js';

const extractionSchema = z.array(z.object({ requirement: requirementSchema, messageId: z.string().min(1), quote: z.string().min(1).max(1000) }).strict()).max(40);
function quantityMatches(quote: string, amount: string, unit: string): boolean {
  if (quantityAppearsInQuote(quote, { amount, unit })) return true;
  let position = -1;
  while ((position = quote.indexOf(amount, position + 1)) >= 0) {
    if (/[第\d.零〇一二两三四五六七八九十百千万亿]/.test(quote[position - 1] ?? '')) continue;
    const following = quote.slice(position + amount.length).trimStart();
    if (!following.startsWith(unit)) continue;
    if (/[A-Za-z]$/.test(unit) && /^[A-Za-z]/.test(following.slice(unit.length))) continue;
    return true;
  }
  return false;
}
export function groundRequirements(request: ServiceRequest, json: string, outcomePredicates: string[] = [], roles: RequirementRoleDefinition[] = []): ServiceRequest {
  const result = structuredClone(request);
  for (const requirement of [...result.requirements]) if (requirement.kind === 'condition' && outcomePredicates.includes(requirement.expected.predicate)) {
    result.successCriteria = [...(result.successCriteria ?? []), requirement]; result.requirements = result.requirements.filter(r => r.id !== requirement.id);
  }
  for (const item of extractionSchema.parse(JSON.parse(json))) {
    const message = request.messages.find(m => m.id === item.messageId);
    if (!message || !message.text.includes(item.quote)) throw new DomainError('CONFLICT', 'Requirement provenance is not an exact quote from this request');
    const r = item.requirement;
    if (r.kind !== 'condition' && r.role && !roles.some(role => role.kind === r.kind && role.role === r.role)) throw new DomainError('INVALID_INPUT', 'Requirement role is not supported by the selected capability');
    const existing = [...result.requirements, ...(result.successCriteria ?? [])].find(x => x.id === r.id || (x.kind !== 'condition' && r.kind !== 'condition' && x.kind === r.kind && x.role === r.role));
    const newer = existing && request.messages.findIndex(m => m.id === message.id) > request.messages.findIndex(m => m.id === existing.provenance.messageId);
    if (existing) {
      if (existing.kind !== r.kind || existing.strength !== r.strength || existing.kind !== 'condition' && r.kind !== 'condition' && existing.role !== r.role
        || digest(existing.expected) !== digest(r.expected) && (!newer || r.kind === 'condition')) throw new DomainError('CONFLICT', 'Model attempted to replace a fixed requirement without a later explicit owner correction');
      // Preserve the original structured value and provenance. Repeating it is
      // not a new text extraction, including currencies that require structure.
      if (!newer || digest(existing.expected) === digest(r.expected)) continue;
    }
    const activeQuote = operativeText(item.quote);
    if (r.kind === 'quantity' && !quantityMatches(activeQuote, r.expected.amount, r.expected.unit)) throw new DomainError('CONFLICT', 'Quantity interpretation differs from its source quote');
    if (r.kind === 'budget') {
      if (r.expected.currency !== 'CNY') throw new DomainError('INVALID_INPUT', 'Non-CNY budgets require explicit structured minor units');
      const amounts = [...activeQuote.matchAll(/(?:CNY|￥|¥)\s*(\d+(?:\.\d{1,2})?)(?![\d.])|(?<![\d.])(\d+(?:\.\d{1,2})?)\s*(?:元|CNY)(?![A-Za-z])/gi)].map(m => m[1] ?? m[2]!);
      const moneyMatches = amounts.some(a => { const [whole, fraction = ''] = a.split('.'); return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0')) === BigInt(r.expected.minor); });
      if (!moneyMatches) throw new DomainError('CONFLICT', 'Budget interpretation differs from its source quote');
    }
    if (r.kind === 'deadline' && r.expected.original !== item.quote) throw new DomainError('CONFLICT', 'Deadline must retain its original expression');
    const sourced = { ...r, id: existing?.id ?? r.id, provenance: { source: 'pa' as const, interpretation: 'quoted_text' as const, messageId: message.id, receivedAt: message.receivedAt, quote: item.quote } };
    if (existing) {
      result.supersededRequirements = [...(result.supersededRequirements ?? []), existing];
      result.requirements = result.requirements.filter(v => v.id !== existing.id);
      if (result.successCriteria) result.successCriteria = result.successCriteria.filter(v => v.id !== existing.id);
    }
    if (r.kind === 'condition' && outcomePredicates.includes(r.expected.predicate)) result.successCriteria = [...(result.successCriteria ?? []), sourced];
    else result.requirements.push(sourced);
  }
  if (result.requirements.length + (result.successCriteria?.length ?? 0) > 40) throw new DomainError('INVALID_INPUT', 'Too many task requirements');
  return result;
}
