import { z } from 'zod';

/** Storage-independent member contracts shared by Gateway and both databases. */
export const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  locale: z.enum(['zh-CN', 'en']),
  timezone: z.string().min(1).max(100).refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }, 'Invalid timezone'),
}).strict();
export const applicationSchema = profileSchema.extend({ consent: z.literal(true) });
export type Profile = z.infer<typeof profileSchema>;
export type MemberStatus = 'new' | 'pending' | 'active' | 'suspended';
export interface Identity { issuer: string; tenant: string; subject: string; displayName?: string; email?: string }
export interface Member extends Profile {
  id: string; issuer: string; tenant: string; subject: string; email?: string;
  status: MemberStatus; acceptedAt?: string; createdAt: string; updatedAt: string;
}
export interface Connection { id: string; clientId: string; scopes: string[]; blocked: boolean; lastSeenAt: string }
export class MemberAccessError extends Error {
  constructor(readonly code: 'membership_required' | 'membership_inactive' | 'connection_revoked') { super(code); }
}
