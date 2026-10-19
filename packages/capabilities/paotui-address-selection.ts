import type { ServiceRequest } from '../ontology/execution.js';
import type { JobStore } from '../core/store.js';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { SavedAddress } from './paotui-atomic.js';

type Choices = { generation: number; addresses: SavedAddress[]; presentedRevision?: number; presentedMessageCount?: number };
const normalize = (value: string) => value.normalize('NFKC').replace(/[\s，。；、：:]/g, '').toLowerCase();
const display = (a: SavedAddress) => a.address + (a.houseNumber ? `（${a.houseNumber}）` : '');
const sameBook = (a: SavedAddress[], b: SavedAddress[]) => digest([...a].sort((x, y) => x.addressId.localeCompare(y.addressId))) === digest([...b].sort((x, y) => x.addressId.localeCompare(y.addressId)));
const label = (c: Choices, i: number) => c.generation === 1 ? `地址${i + 1}` : `新${c.generation}-${i + 1}`;
const failure = (): never => { throw new DomainError('CONFLICT', 'Address choice is missing, ambiguous, changed, or was not explicitly supplied by the owner. Ask the owner using [[saved_addresses]].'); };
/** Private address resolution only. It neither calls a provider nor chooses an action. */
export class PaotuiAddressSelection {
  constructor(private store: JobStore) {}
  private key(connection: string) { return `agent-paotui-addresses:${connection}`; }
  private choices(owner: string, request: ServiceRequest, connection: string) { return this.store.preparationContext<Choices>(owner, request.id, this.key(connection)); }
  observe(owner: string, request: ServiceRequest, connection: string, addresses: SavedAddress[]) {
    const old = this.choices(owner, request, connection);
    // Preserve displayed labels when only provider ordering changes. Content changes invalidate them.
    if (old && sameBook(old.addresses, addresses)) return;
    this.store.savePreparationContext(owner, request.id, this.key(connection), { generation: (old?.generation ?? 0) + 1, addresses } satisfies Choices);
  }
  present(owner: string, request: ServiceRequest, connection: string): string {
    const c = this.choices(owner, request, connection); if (!c) return failure();
    if (!c.addresses.length) return '本人地址簿暂无地址，请先在美团保存同城寄件和收件地址后继续。';
    if (c.addresses.length > 30) return '本人地址簿超过30条，请先在美团整理后继续。';
    if (c.presentedRevision === undefined) { c.presentedRevision = request.revision; c.presentedMessageCount = request.messages.length; }
    this.store.savePreparationContext(owner, request.id, this.key(connection), c);
    return `${c.generation > 1 ? '地址簿已变化，旧选项已失效。\n' : ''}本人保存地址：\n${c.addresses.map((a, i) => `${label(c, i)}：${display(a)}`).join('\n')}`;
  }
  select(owner: string, request: ServiceRequest, connection: string, addresses: SavedAddress[], selector: string, role: 'sender' | 'recipient'): SavedAddress {
    const c = this.choices(owner, request, connection); if (!c || !sameBook(c.addresses, addresses) || addresses.length > 30) return failure();
    const value = normalize(selector), messages = request.messages.map(m => normalize(m.text));
    const after = c.presentedRevision !== undefined && request.revision > c.presentedRevision ? request.messages.slice(c.presentedMessageCount).map(m => normalize(m.text)) : [];
    const index = /^(?:地址)?([1-9]\d*)$/.exec(value)?.[1];
    if (index && /^\d+$/.test(value)) {
      if (c.generation !== 1 || !after.some(text => {
        const pairs = [...text.matchAll(/(?<![\w.])(?:地址)?([1-9]\d*)(?:寄到|寄往|送到|到|→|->)(?:地址)?([1-9]\d*)(?!\d|公斤|千克|kg|克|g)/g)];
        return pairs.some(m => m[role === 'sender' ? 1 : 2] === index);
      })) return failure();
      return c.addresses[Number(index) - 1] ?? failure();
    }
    const chosen = c.addresses.findIndex((_a, i) => normalize(label(c, i)) === value);
    if (chosen >= 0) {
      if (!after.some(t => new RegExp(`${value}(?!\\d)`).test(t))) return failure();
      return c.addresses[chosen]!;
    }
    if (/^(?:地址\d+|新\d+-\d+|\d+)$/.test(value) || value.length < 2 || !messages.some(m => m.includes(value))) return failure();
    const matches = c.addresses.filter(a => normalize(display(a)).includes(value) || typeof a.tag === 'string' && normalize(a.tag) === value);
    return matches.length === 1 ? matches[0]! : failure();
  }
}
