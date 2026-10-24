import { digest } from './delegation.js';
import type { ConfirmedInput, ConfirmedInputs, ServiceRequest } from '../ontology/execution.js';

export type InputUpdate = { field: string; status: ConfirmedInput['status']; value?: unknown; quote: string };

/** Domain parsers identify explicit owner facts. The common reducer preserves
 * their history while exposing only the newest value of each field as current. */
export function currentInputs(request: ServiceRequest, parse: (text: string) => InputUpdate[]): ConfirmedInputs {
  const fields: Record<string, ConfirmedInput> = {}, history: ConfirmedInput[] = [];
  let revision = 0;
  for (const [messageIndex, message] of request.messages.entries()) {
    for (const update of parse(message.text)) {
      const fact: ConfirmedInput = { ...update, revision: ++revision, source: { messageId: message.id, messageIndex, receivedAt: message.receivedAt } };
      if (fields[update.field]) history.push(fields[update.field]!);
      fields[update.field] = fact;
    }
  }
  return { version: '1', revision, messageDigest: digest(request.messages), fields, history };
}

/** Preserve exact source quotations separately from the operative wording.
 * In particular, "not X but Y" and "X is canceled" do not confirm X. */
export function operativeFragments(text: string): { quote: string; text: string; correction: boolean }[] {
  return text.split(/[，,；;。\n]/u).flatMap(quote => {
    const raw = quote.trim(); if (!raw) return [];
    let value = raw.normalize('NFKC');
    const correction = /改为|改成|调整为|更正为|换成|换为|而是|现在(?:是|按|用)|最终|instead|change\s+to/i.test(value);
    const replace = /(?:从|不是|不要|不用|别用)(.+?)(?:改为|改成|调整为|更正为|换成|换为|而是)(.+)/u.exec(value);
    if (replace) value = value.slice(0, replace.index) + replace[2]!;
    else {
      const target = /(?:改为|改成|调整为|更正为|换成|换为|而是|现在是|最终(?:是|按|用)?)(.+)$/u.exec(value);
      if (target && !/不要改|不改|不必改|别改/u.test(value)) value = target[1]!;
      else if (/(?:原先|原来|之前|此前|旧的|原定)/u.test(value) && !/(?:还是|仍然|保持|沿用)/u.test(value)) return [];
    }
    if (/(?:作废|取消|不对|错误|写错|弃用|不要了|不用了|不采用|不选)/u.test(value)) return [];
    const negative = /(?:不是|不要|不用|别用|not\s+)/iu.exec(value);
    if (negative) value = value.slice(0, negative.index);
    if (!value.trim()) return [];
    return [{ quote: raw, text: value, correction }];
  });
}

export function operativeText(text: string): string { return operativeFragments(text).map(f => f.text).join('，'); }

export function currentRequestView(request: ServiceRequest): ServiceRequest {
  const view = structuredClone(request);
  delete view.supersededRequirements; delete view.supersededConditions;
  if (view.confirmedInputs) for (const value of Object.values(view.confirmedInputs)) value.history = [];
  return view;
}
