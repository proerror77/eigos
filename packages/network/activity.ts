import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { fail, type NetworkActor, type Publication, type ResultRef } from './contracts.js';
import type { FollowEdge, UpdatesQuery } from './activity-contracts.js';
import type { NetworkQueryResult } from './service.js';
import { NetworkStore } from './store.js';

const cursorSchema = z.object({
  version: z.literal(1), context: z.string(), epoch: z.string(), type: z.enum(['page', 'checkpoint']),
  last: z.number().int().nonnegative().safe(), highWater: z.number().int().nonnegative().safe(),
  issuedAt: z.number().int().nonnegative().safe(), expiresAt: z.number().int().nonnegative().safe(),
}).strict().refine(v => v.last <= v.highWater && (v.type !== 'checkpoint' || v.last === v.highWater));
type Cursor = z.infer<typeof cursorSchema>;
export interface ActivityResult { version: number; items: ActivityItem[]; page: { hasMore: boolean; cursor?: string; checkpoint?: string }; cursorExpiresAt: string; resetRequired: false }
export interface ActivityItem { eventId: string; kind: 'published' | 'need_closed'; committedAt: string; publication: NetworkQueryResult }

/** Pull-only notifications. Filters never grant access and reads never emit business events. */
export class NetworkActivity {
  constructor(private store: NetworkStore, private visible: (pub: Publication, memberId: string) => NetworkQueryResult | undefined,
    private visibleProfile: (profileId: string, spaceId: string, memberId: string) => void) {}
  follows(owner: string, profileId: string) { return this.store.list('follow', owner).filter(f => f.profileId === profileId); }
  follow(a: NetworkActor, input: { targetProfileId: string; spaceId: string; following: boolean }): ResultRef[] {
    const old = this.follows(a.owner, a.profileId).find(f => f.targetProfileId === input.targetProfileId);
    if (old?.following === input.following) return [{ kind: 'follow', id: old.id }];
    if (!old && !input.following) return [];
    if (input.following) this.visibleProfile(input.targetProfileId, input.spaceId, a.memberId);
    if (!old) this.store.quota('follow', a.owner);
    const record: FollowEdge = old ?? { id: randomUUID(), owner: a.owner, profileId: a.profileId, targetProfileId: input.targetProfileId,
      spaceId: input.spaceId, following: false, revision: 0, createdAt: new Date(this.store.now()).toISOString() };
    record.following = input.following; record.revision++; if (input.following) record.spaceId = input.spaceId;
    this.store.put('follow', record); this.store.event('follow_changed', record.id);
    return [{ kind: 'follow', id: record.id }];
  }
  private encode(cursor: Cursor) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.store.activityKey(), iv);
    cipher.setAAD(Buffer.from('eigos.network.updates@1'));
    const body = Buffer.concat([cipher.update(JSON.stringify(cursor), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  }
  private decode(raw: string, context: string, epoch: string): Cursor {
    try {
      const bytes = Buffer.from(raw, 'base64url');
      if (bytes.length < 29 || bytes.toString('base64url') !== raw) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.store.activityKey(), bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from('eigos.network.updates@1')); decipher.setAuthTag(bytes.subarray(12, 28));
      const value = cursorSchema.parse(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()));
      if (value.context !== context || value.epoch !== epoch || value.issuedAt > this.store.now() || value.expiresAt <= this.store.now()
        || value.expiresAt - value.issuedAt !== 900000 || value.highWater > this.store.visibilityRevision()) throw new Error();
      return value;
    } catch { return fail('CURSOR_STALE'); }
  }
  updates(owner: string, memberId: string, args: UpdatesQuery, policyContext: unknown): ActivityResult {
    const follows = args.asProfileId ? this.follows(owner, args.asProfileId) : [];
    const targets = new Set(follows.filter(f => f.following).map(f => f.targetProfileId));
    const context = digest([owner, memberId, args.spaceId, args.mode, args.asProfileId ?? null]);
    const policyEpoch = this.store.activityEpoch();
    const epoch = digest([policyEpoch, policyContext, follows.map(f => [f.id, f.revision])]);
    const prior = args.cursor ? this.decode(args.cursor, context, epoch) : undefined;
    const issuedAt = this.store.now();
    const state: Cursor = prior?.type === 'page' ? prior : {
      version: 1, context, epoch, type: 'page', last: prior?.last ?? 0, highWater: this.store.visibilityRevision(),
      issuedAt, expiresAt: issuedAt + 900000,
    };
    const rows = this.store.events(state.last, state.highWater), items: ActivityItem[] = [];
    let scanned = 0, bytes = 0;
    for (const row of rows) {
      if (scanned === 200 || items.length === args.limit) break;
      let item: ActivityItem | undefined;
      if (row.publicationId && (row.kind === 'published' || row.kind === 'need_closed')) {
        const pub = this.store.get('publication', row.publicationId);
        if (row.objectRevision === this.store.publicationRevision(pub) && (args.mode === 'space' || targets.has(pub.profileId))) {
          const view = this.visible(pub, memberId);
          if (view?.spaceId === args.spaceId) item = { eventId: row.eventId, kind: row.kind, committedAt: row.at, publication: view };
        }
      }
      if (item) {
        const size = Buffer.byteLength(JSON.stringify(item)); if (bytes + size > 60000) break;
        items.push(item); bytes += size;
      }
      scanned++; state.last = row.seq;
    }
    if (this.store.activityEpoch() !== policyEpoch) fail('CURSOR_STALE');
    const hasMore = rows.length > scanned;
    if (!hasMore) { state.last = state.highWater; state.type = 'checkpoint'; }
    const cursor = this.encode(state);
    return { version: 1, items, page: { hasMore, ...(hasMore ? { cursor } : { checkpoint: cursor }) },
      cursorExpiresAt: new Date(state.expiresAt).toISOString(), resetRequired: false };
  }
}
