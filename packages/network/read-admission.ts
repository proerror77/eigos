import { z } from 'zod';
import { digest } from '../core/delegation.js';
import type { JobStore } from '../core/store.js';
import { fail } from './contracts.js';
import { INQUIRY_CONTEXT_KEY, sourceSchema, type Inquiry } from './inquiry-contracts.js';
import type { NetworkReadMember, NetworkStore } from './store.js';
import type { DirectoryMember } from './directory.js';

const id = z.string().min(1).max(200), timestamp = z.iso.datetime({ offset: true });
const taskReadAdmissionSchema = z.object({
  version: z.literal(1), scope: z.literal('network:read'), owner: z.string().min(1).max(2000), taskId: id, inquiryId: id,
  memberId: id, installationId: id, clientId: id, profileId: id, bindingId: id, bindingRevision: z.number().int().positive(),
  choiceId: id, issuedAt: timestamp, expiresAt: timestamp,
}).strict();

export function admittedDirectoryMember(store: NetworkStore, members: NetworkReadMember[], id: string): DirectoryMember {
  const admitted = members.find(member => member.id === id); if (!admitted) return fail('NETWORK_MEMBERSHIP_REQUIRED', 403);
  store.checkFence(id);
  const identity = z.tuple([z.string(), z.string(), z.string()]).parse(JSON.parse(admitted.owner));
  return { id, issuer: identity[0], tenant: identity[1], subject: identity[2] };
}

/** Reconstructed only from an exact owned task and its existing trusted inquiry
 * context. A captured owner string alone is never a network credential. */
export function validateTaskNetworkReadAdmission(jobs: JobStore, store: NetworkStore, owner: string, taskId: string) {
  jobs.get(owner, taskId);
  const raw = jobs.preparationContext(owner, taskId, INQUIRY_CONTEXT_KEY), source = sourceSchema.safeParse(raw);
  if (!source.success) return fail('NETWORK_READ_ADMISSION_REQUIRED', 403);
  const inquiry = store.list('inquiry', owner).find(value => value.taskId === taskId);
  if (!inquiry) return fail('NETWORK_READ_ADMISSION_REQUIRED', 403);
  const parsed = taskReadAdmissionSchema.safeParse(inquiry.readAdmission);
  if (!parsed.success) return fail('NETWORK_READ_ADMISSION_REQUIRED', 403);
  const a = parsed.data;
  if (a.owner !== owner || a.taskId !== taskId || a.inquiryId !== inquiry.id || a.memberId !== inquiry.source.buyerMemberId
    || a.profileId !== inquiry.profileId || !source.success || digest(source.data) !== digest(inquiry.source)
    || a.issuedAt !== inquiry.createdAt || Date.parse(a.issuedAt) > store.now() || Date.parse(a.expiresAt) <= store.now()
    || Date.parse(a.expiresAt) > Date.parse(a.issuedAt) + 86400000) return fail('NETWORK_READ_ADMISSION_EXPIRED', 403);
  const members = store.currentReadMembers(), member = members.find(value => value.id === a.memberId && value.owner === owner);
  if (!member?.installations.some(value => value.id === a.installationId && value.clientId === a.clientId)) return fail('NETWORK_READ_ADMISSION_REQUIRED', 403);
  store.checkFence(a.memberId, a.installationId, a.clientId);
  const binding = store.get('binding', a.bindingId, owner), profile = store.get('profile', a.profileId, owner), choice = store.get('choice', a.choiceId, owner);
  if (profile.state === 'suspended' || profile.memberId !== a.memberId || binding.revoked || binding.revision !== a.bindingRevision
    || binding.profileId !== a.profileId || binding.memberId !== a.memberId || binding.installationId !== a.installationId || binding.clientId !== a.clientId
    || !binding.allowedCommands.includes('inquiry.manage') || choice.kind !== 'convert' || choice.status !== 'consumed'
    || choice.resultId !== inquiry.id || choice.memberId !== a.memberId || choice.approvedBy !== a.memberId
    || choice.profileId !== a.profileId || choice.bindingId !== a.bindingId || choice.bindingRevision !== a.bindingRevision
    || choice.materialDigest !== inquiry.selectionDigest || digest(choice.input) !== inquiry.inputDigest) return fail('NETWORK_READ_ADMISSION_REQUIRED', 403);
  return { inquiry: inquiry as Inquiry, members, memberId: a.memberId, installationId: a.installationId,
    identityDigest: digest([owner, taskId, a]), expiresAt: a.expiresAt };
}
