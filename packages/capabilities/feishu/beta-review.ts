import { randomUUID } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { Conflict } from '../../core/identity.js';
import { readPrivateSourceFile } from '../../core/private-source.js';
import type { BetaApplicant, BetaReviewProvider } from '../../runtime/beta-review.js';

const api = 'https://open.feishu.cn/open-apis';
const token = z.string().min(8).max(8192).regex(/^[^\s]+$/);
const credentials = z.strictObject({ accessToken: token, refreshToken: token, expiresAt: z.iso.datetime() });
export const betaFeishuConfig = z.strictObject({
  baseToken: z.string().regex(/^[A-Za-z0-9]+$/), tableId: z.string().regex(/^tbl[A-Za-z0-9]+$/),
  approverOpenId: z.string().regex(/^ou_[A-Za-z0-9]+$/),
  mailbox: z.email(), publicUrl: z.url().refine(value => new URL(value).origin === value && value.startsWith('https://')),
  appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), appSecretFile: z.string(), userTokenFile: z.string(),
});
type FeishuConfig = z.infer<typeof betaFeishuConfig>;
const recordId = z.string().regex(/^rec[A-Za-z0-9]+$/);
const record = z.object({
  record_id: recordId, fields: z.record(z.string(), z.unknown()),
  last_modified_by: z.object({ id: z.string() }).optional(),
});
const asText = (value: unknown) => typeof value === 'string' ? value :
  z.array(z.object({ text: z.string() })).safeParse(value).data?.map(part => part.text).join('');

export const betaMailSubject = 'EIGOS Beta 审核通过，可以开始测试';
export function betaMailText(publicUrl: string) {
  return ['你好，', '', '你的 EIGOS Beta 申请已通过，可以开始测试。', '',
    '请使用申请时验证的邮箱登录账号页，并接入你的 Agent。',
    new URL('/account', publicUrl).href, '', 'ManDoNothing · EIGOS', 'Human Thinks. Agents Execute.'].join('\r\n');
}

export class FeishuBetaReview implements BetaReviewProvider {
  private readonly records: string;
  private readonly drafts: string;
  constructor(private readonly config: FeishuConfig, private readonly fetcher = fetch) {
    this.records = `/bitable/v1/apps/${config.baseToken}/tables/${config.tableId}/records`;
    this.drafts = `/mail/v1/user_mailboxes/${encodeURIComponent(config.mailbox)}/drafts`;
  }

  private async accessToken() {
    const path = this.config.userTokenFile;
    const held = credentials.parse(JSON.parse(await readPrivateSourceFile(path)));
    if (Date.parse(held.expiresAt) - Date.now() > 60_000) return held.accessToken;
    const secret = token.parse((await readPrivateSourceFile(this.config.appSecretFile)).trim());
    const response = await this.fetcher(api + '/authen/v2/oauth/token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: this.config.appId,
        client_secret: secret, refresh_token: held.refreshToken }),
    });
    const refreshed = z.object({ code: z.literal(0).optional(), access_token: token, refresh_token: token,
      expires_in: z.number().int().min(61).max(86400) }).safeParse(await response.json());
    if (!response.ok || !refreshed.success) throw new Conflict('飞书账号需要重新授权');
    const { access_token: accessToken, refresh_token: refreshToken, expires_in: ttl } = refreshed.data;
    const staged = path + '.' + randomUUID();
    await writeFile(staged, JSON.stringify({ accessToken, refreshToken, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() }),
      { mode: 0o600, flag: 'wx', flush: true });
    await rename(staged, path);
    return accessToken;
  }

  private async request<T extends z.ZodType>(path: string, method: 'POST' | 'PUT', body: unknown, output: T) {
    const response = await this.fetcher(api + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(15000), body: JSON.stringify(body),
      headers: { Authorization: 'Bearer ' + await this.accessToken(), 'Content-Type': 'application/json' },
    });
    const result = z.object({ code: z.literal(0), data: z.unknown() }).safeParse(await response.json());
    if (!response.ok || !result.success) throw new Conflict('飞书没有确认这次操作');
    return output.parse(result.data.data);
  }

  private async find(applicationId: string) {
    const found = await this.request(this.records + '/search?page_size=2&user_id_type=open_id', 'POST', {
      field_names: ['申请编号', '批准使用'],
      automatic_fields: true,
      filter: { conjunction: 'and', conditions: [{ field_name: '申请编号', operator: 'is', value: [applicationId] }] },
    }, z.object({ items: z.array(record).default([]), has_more: z.boolean() }));
    if (found.has_more || found.items.length > 1 || found.items.some(row => asText(row.fields['申请编号']) !== applicationId))
      throw new Conflict('飞书申请编号无法唯一核对');
    return found.items[0];
  }

  async publish(applicant: BetaApplicant) {
    const current = await this.find(applicant.applicationId);
    if (current) return current.record_id;
    const created = await this.request(this.records + '/batch_create?client_token=' + applicant.applicationId, 'POST', {
      records: [{ fields: { '申请编号': applicant.applicationId, '已验证邮箱': applicant.email, '测试用途': applicant.purpose,
        '申请时间': applicant.appliedAt.getTime(), '批准使用': false, '开通状态': '待审核', '邮件状态': '待审批' } }],
    }, z.object({ records: z.tuple([z.object({ record_id: recordId })]) }));
    return created.records[0].record_id;
  }

  async approved(applicationId: string, originalRecord: string) {
    const row = await this.find(applicationId);
    return row?.record_id === originalRecord && row.fields['批准使用'] === true &&
      row.last_modified_by?.id === this.config.approverOpenId;
  }

  async writeStatus(originalRecord: string, mail: 'pending' | 'sent' | 'unknown') {
    const verified = await this.request(this.records + '/' + recordId.parse(originalRecord), 'PUT', {
      fields: { '开通状态': '已开通', '邮件状态': { pending: '待发送', sent: '已发送', unknown: '待核对' }[mail] },
    }, z.object({ record: z.object({ record_id: recordId }) }));
    if (verified.record.record_id !== originalRecord) throw new Conflict('飞书回执的申请记录不匹配');
  }

  async createDraft(applicationId: string, verifiedEmail: string) {
    const email = z.email().parse(verifiedEmail);
    const message = [
      `From: EIGOS <${this.config.mailbox}>`, `To: <${email}>`,
      `Subject: =?UTF-8?B?${Buffer.from(betaMailSubject).toString('base64')}?=`,
      `Message-ID: <eigos-beta-${z.uuid().parse(applicationId)}@${this.config.mailbox.split('@')[1]}>`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
      Buffer.from(betaMailText(this.config.publicUrl)).toString('base64').match(/.{1,76}/g)!.join('\r\n'), '',
    ].join('\r\n');
    const { draft } = await this.request(this.drafts, 'POST', { raw: Buffer.from(message).toString('base64url') },
      z.object({ draft: z.object({ id: z.string().min(1).max(256) }) }));
    return draft.id;
  }

  async sendDraft(draftId: string) {
    const receipt = await this.request(this.drafts + '/' + encodeURIComponent(draftId) + '/send', 'POST', {},
      z.object({ message_id: z.string().min(1), automation_send_disable: z.unknown().optional() }));
    if (receipt.automation_send_disable) throw new Conflict('飞书邮箱未开放自动发送');
    return { messageId: receipt.message_id };
  }
}
