import type { ServiceRequest } from '../ontology/execution.js';
import type { JobStore } from '../core/store.js';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { SavedAddress } from './paotui-atomic.js';
import { randomUUID } from 'node:crypto';

type Presentation = { generation: number; addresses: SavedAddress[]; presentedRevision: number; presentedMessageCount: number };
type Confirmed = { address: SavedAddress; messageIndex: number };
type Choices = { generation: number; addresses: SavedAddress[]; presentedRevision?: number; presentedMessageCount?: number; presentations?: Presentation[]; confirmations?: Partial<Record<'sender' | 'recipient', Confirmed>>; confirmFromMessage?: number };
type AccountContext = { authorizationEpoch: string; credentialContext: string; choiceContext: string; accountIdentity?: string };
const normalize = (value: string) => value.normalize('NFKC').replace(/[\s，。；、：:]/g, '').toLowerCase();
const display = (a: SavedAddress) => a.address + (a.houseNumber ? `（${a.houseNumber}）` : '');
const sameBook = (a: SavedAddress[], b: SavedAddress[]) => digest([...a].sort((x, y) => x.addressId.localeCompare(y.addressId))) === digest([...b].sort((x, y) => x.addressId.localeCompare(y.addressId)));
const label = (c: Pick<Choices, 'generation'>, i: number) => c.generation === 1 ? `地址${i + 1}` : `新${c.generation}-${i + 1}`;
const failure = (): never => { throw new DomainError('CONFLICT', 'Address choice is missing, ambiguous, changed, or was not explicitly supplied by the owner. Ask the owner using [[saved_addresses]].'); };
const labelToken = '(?:地址[1-9]\\d*|新[1-9]\\d*-[1-9]\\d*|[1-9]\\d*)';
const canonicalLabel = (value: string, p: Presentation) => p.generation === 1 && /^\d+$/.test(value) ? `地址${value}` : value;
function presentations(c: Choices): Presentation[] {
  const saved = c.presentations ?? [];
  if (c.presentedRevision === undefined || c.presentedMessageCount === undefined || saved.some(p => p.generation === c.generation)) return saved;
  return [...saved, { generation: c.generation, addresses: c.addresses, presentedRevision: c.presentedRevision, presentedMessageCount: c.presentedMessageCount }];
}
/** Private address resolution only. User choices bind the list actually shown
 * before that reply; provider reads always use the current fresh address book. */
export class PaotuiAddressSelection {
  constructor(private store: JobStore) {}
  private key(connection: string) { return `agent-paotui-addresses:${connection}`; }
  private account(owner: string, request: ServiceRequest) { return this.store.preparationContext<AccountContext>(owner, request.id, 'agent-paotui-account'); }
  private context(owner: string, request: ServiceRequest, connection: string) {
    const account = this.account(owner, request);
    return account?.credentialContext === connection ? account.choiceContext : connection;
  }
  private choices(owner: string, request: ServiceRequest, connection: string) { return this.store.preparationContext<Choices>(owner, request.id, this.key(this.context(owner, request, connection))); }
  private save(owner: string, request: ServiceRequest, connection: string, choices: Choices) { this.store.savePreparationContext(owner, request.id, this.key(this.context(owner, request, connection)), choices); }
  observe(owner: string, request: ServiceRequest, connection: string, addresses: SavedAddress[], identity?: { authorizationEpoch: string; accountIdentity?: string }) {
    const previous = this.account(owner, request), authorizationEpoch = identity?.authorizationEpoch ?? connection;
    const sameCredential = previous?.credentialContext === connection && previous.authorizationEpoch === authorizationEpoch;
    const sameAccount = !!identity?.accountIdentity && identity.accountIdentity === previous?.accountIdentity;
    const accountChanged = sameCredential && !!identity?.accountIdentity && !!previous?.accountIdentity && !sameAccount;
    const continuous = previous && !accountChanged && (sameCredential || previous.authorizationEpoch === authorizationEpoch && sameAccount);
    const choiceContext = continuous ? previous.choiceContext : previous?.choiceContext === connection ? digest({ connection, change: randomUUID() }) : connection;
    const accountIdentity = identity?.accountIdentity ?? (sameCredential ? previous?.accountIdentity : undefined);
    this.store.savePreparationContext(owner, request.id, 'agent-paotui-account', { authorizationEpoch, credentialContext: connection, choiceContext, ...(accountIdentity ? { accountIdentity } : {}) } satisfies AccountContext);
    const legacyChanged = !previous && !this.store.preparationContext(owner, request.id, this.key(connection))
      && this.store.hasPreparationContext(owner, request.id, 'agent-paotui-addresses:');
    const requiresConfirmation = !!previous && !continuous || legacyChanged;
    const old = requiresConfirmation ? undefined : this.choices(owner, request, connection);
    if (old && sameBook(old.addresses, addresses)) return;
    this.save(owner, request, connection, { generation: (old?.generation ?? 0) + 1, addresses,
      presentations: old ? presentations(old) : [], confirmations: old?.confirmations,
      confirmFromMessage: requiresConfirmation ? request.messages.length : old?.confirmFromMessage } satisfies Choices);
  }
  present(owner: string, request: ServiceRequest, connection: string): string {
    const c = this.choices(owner, request, connection); if (!c) return failure();
    if (!c.addresses.length) return '本人地址簿暂无地址，请先在美团保存同城寄件和收件地址后继续。';
    if (c.addresses.length > 30) return '本人地址簿超过30条，请先在美团整理后继续。';
    if (c.presentedRevision === undefined) { c.presentedRevision = request.revision; c.presentedMessageCount = request.messages.length; }
    c.presentations = presentations(c);
    this.save(owner, request, connection, c);
    return `${c.generation > 1 ? '地址簿已变化，请使用本次展示的编号；此前已确认且内容未变化的地址仍保留。\n' : ''}本人保存地址：\n${c.addresses.map((a, i) => `${label(c, i)}：${display(a)}`).join('\n')}`;
  }
  private numericChoice(c: Choices, request: ServiceRequest, role: 'sender' | 'recipient') {
    const shown = presentations(c);
    for (let index = request.messages.length - 1; index >= 0; index--) {
      const p = shown.findLast(p => p.presentedMessageCount <= index && p.presentedRevision < request.revision);
      if (!p) continue;
      const text = normalize(request.messages[index]!.text), choices = new Set<string>();
      const pairs = text.matchAll(new RegExp(`(?<![\\w.])(${labelToken})(?:寄到|寄往|送到|到|→|->)(${labelToken})(?!\\d|公斤|千克|kg|克|g)`, 'g'));
      for (const pair of pairs) choices.add(pair[role === 'sender' ? 1 : 2]!);
      const prefix = role === 'sender' ? '(?:寄件|发件|寄出)' : '(?:收件|收货|接收)';
      const namedRole = `${prefix}(?:方)?(?:用|选择|选|为|是)?(地址[1-9]\\d*|新[1-9]\\d*-[1-9]\\d*)(?!\\d)`;
      const numberedRole = `${prefix}(?:方)?地址(?:用|选择|选|为|是)?([1-9]\\d*)(?!\\d|公斤|千克|kg|克|g)`;
      for (const pattern of [namedRole, numberedRole]) for (const match of text.matchAll(new RegExp(pattern, 'g'))) choices.add(match[1]!);
      const labels = [...new Set([...choices].map(value => canonicalLabel(value, p)))];
      if (!labels.length) continue;
      if (labels.length !== 1) return failure();
      const selected = p.addresses.find((_a, i) => label(p, i) === labels[0]);
      if (!selected) return failure();
      return { selected, label: labels[0]!, presentation: p, messageIndex: index };
    }
  }
  select(owner: string, request: ServiceRequest, connection: string, addresses: SavedAddress[], selector: string, role: 'sender' | 'recipient', record = false): SavedAddress {
    const c = this.choices(owner, request, connection); if (!c || !sameBook(c.addresses, addresses) || addresses.length > 30) return failure();
    const confirm = (address: SavedAddress, messageIndex: number) => {
      const old = c.confirmations?.[role];
      if (messageIndex < (c.confirmFromMessage ?? 0) || old && messageIndex <= old.messageIndex && digest(address) !== digest(old.address)) return failure();
      if (record) {
        c.confirmations = { ...c.confirmations, [role]: { address, messageIndex } };
        this.save(owner, request, connection, c);
      }
      return address;
    };
    const value = normalize(selector), chosen = this.numericChoice(c, request, role);
    if (/^(?:地址\d+|新\d+-\d+|\d+)$/.test(value)) {
      if (!chosen || canonicalLabel(value, chosen.presentation) !== chosen.label) return failure();
      const current = addresses.find(a => a.addressId === chosen.selected.addressId);
      if (!current || digest(current) !== digest(chosen.selected)) return failure();
      return confirm(current, chosen.messageIndex);
    }
    const mentioned = request.messages.findLastIndex(m => normalize(m.text).includes(value));
    if (value.length < 2 || mentioned < 0) return failure();
    const matches = c.addresses.filter(a => normalize(display(a)).includes(value) || typeof a.tag === 'string' && normalize(a.tag) === value);
    if (matches.length !== 1 || chosen && mentioned <= chosen.messageIndex && digest(matches[0]) !== digest(chosen.selected)) return failure();
    return confirm(matches[0]!, mentioned);
  }
}
