import type { Config } from '../core/config.js';
import { DomainError, ownerKey, requireScope, type Principal } from '../core/domain.js';
import { MemberSourceVault, SOURCE_PROVIDER, type SourceActor } from '../core/member-source.js';
import type { TaskService } from '../core/tasks.js';
import type { MemberStore } from './store.js';
import { PAOTUI_AGENT_REFS } from '../capabilities/paotui-agent.js';

/** Identity comes exclusively from the verified registered PA, never upload arguments. */
export class MemberSourceService {
  constructor(private vault: MemberSourceVault, private members: MemberStore, private tasks: TaskService, private config: Config) {}
  private actor(p: Principal, token: string, write = false): SourceActor {
    requireScope(p, write ? 'sources:write' : 'sources:read');
    if (p.clientId !== this.config.OIDC_AGENT_CLIENT_ID) throw new DomainError('FORBIDDEN', 'A registered personal agent is required');
    this.members.authorize(p);
    const registration = this.members.agents.authorize(p, token), member = this.members.find(p);
    if (!member || !this.config.EIGOS_NETWORK_MEMBER_IDS.includes(member.id) || registration.memberId !== member.id) throw new DomainError('FORBIDDEN', 'Source connection requires an enrolled member');
    return { owner: ownerKey(p), memberId: member.id, installationId: registration.id, clientId: p.clientId };
  }
  status(p: Principal, token: string) { return this.vault.status(this.actor(p, token).owner); }
  list(p: Principal, token: string) {
    return { sources: [{ ...this.status(p, token), capabilityRefs: [PAOTUI_AGENT_REFS.quote, PAOTUI_AGENT_REFS.addresses],
      authorization: { provider: SOURCE_PROVIDER, method: 'pa_supplied_credential', beginTool: 'begin_source_connection', statusTool: 'get_source_connection', revokeTool: 'revoke_source_connection', resumeTool: 'resume_source_task', credentialInput: 'private_http_only', requiresUserOwnedAccount: true } }] };
  }
  begin(p: Principal, token: string, input: unknown) { return this.vault.begin(this.actor(p, token, true), input); }
  complete(p: Principal, token: string, input: unknown) { return this.vault.complete(this.actor(p, token, true), input); }
  revoke(p: Principal, token: string, input: unknown) { return this.vault.revoke(this.actor(p, token, true), input); }
  resume(p: Principal, token: string, input: unknown) { const actor = this.actor(p, token); return this.tasks.resumeSource(p, input, owner => { if (owner !== actor.owner) throw new DomainError('FORBIDDEN', 'Source owner mismatch'); this.vault.grant(owner); }); }
}
