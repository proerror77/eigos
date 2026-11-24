import { createDecipheriv, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { z } from 'zod';
import { readPrivateSourceFile } from '../packages/core/private-source.js';
import { Accounts } from '../packages/runtime/accounts.js';
import { Database } from '../packages/runtime/database.js';

export const reviewCallbackPath = '/callbacks/feishu/beta-review';
const api = 'https://open.feishu.cn/open-apis';
const messageId = z.string().regex(/^om_[A-Za-z0-9]+$/);
const appId = z.string().regex(/^cli_[A-Za-z0-9]+$/);
const openId = z.string().regex(/^ou_[A-Za-z0-9]+$/);
const installedConfig = z.strictObject({
  appId, reviewerOpenId: openId, appSecretFile: z.string(),
  verificationTokenFile: z.string(), encryptKeyFile: z.string(),
  port: z.number().int().min(1024).max(65535).default(3261),
});
const signatureHeaders = z.object({ timestamp: z.string().regex(/^\d{10,13}$/),
  nonce: z.string().min(1).max(128), signature: z.string().regex(/^[a-f0-9]{64}$/i) });
const challenge = z.object({ type: z.literal('url_verification'), challenge: z.string().min(1).max(1024), token: z.string() });
const signedEvent = z.object({
  schema: z.literal('2.0'),
  header: z.object({ app_id: appId, event_type: z.literal('card.action.trigger'), token: z.string() }),
  event: z.object({ operator: z.object({ open_id: openId }), context: z.object({ open_message_id: messageId }),
    action: z.object({ tag: z.literal('button'), value: z.strictObject({ kind: z.literal('eigos_beta_approve'), key: z.uuid() }) }) }),
});
const encBody = z.object({ encrypt: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/) });
const eq = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const toast = (content: string, type: 'info' | 'success' | 'error' = 'info') => ({ toast: { type, content } });
type CallbackConfig = { appId: string; reviewerOpenId: string; encryptKey: string; verificationToken: string };
type Entry = { owner: string; email: string; email_hash: string };
type CardRow = { key: string; message_id: string | null; reviewed_at: Date | null; attempted_at: Date | null; finished: boolean };
type Status = 'pending' | 'active' | 'closed';
const statusText: Record<Status, string> = { pending: '待审核', active: '已开通', closed: '申请已变更' };

function card(key: string, email: string, status: Status) {
  const line = (content: string) => ({ tag: 'div', text: { tag: 'plain_text', content } });
  return {
    config: { update_multi: true },
    header: { template: status === 'active' ? 'green' : 'blue',
      title: { tag: 'plain_text', content: 'EIGOS Beta · ' + statusText[status] } },
    elements: [
      line('已验证邮箱  ' + email),
      ...(status === 'pending' ? [{
        tag: 'action', actions: [{ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '批准开通' },
          value: { kind: 'eigos_beta_approve', key } }],
      }] : []),
    ],
  };
}

export class FeishuReviewCards {
  private token?: { token: string; until: number };
  constructor(private readonly app: string, private readonly secret: string,
    private readonly reviewer: string, private readonly fetcher = fetch) {}
  private async accessToken() {
    if (this.token && this.token.until > Date.now() + 60000) return this.token.token;
    const result = await this.fetcher(api + '/auth/v3/tenant_access_token/internal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ app_id: this.app, app_secret: this.secret }),
    });
    const body = z.object({ code: z.literal(0), tenant_access_token: z.string().min(8).max(8192),
      expire: z.number().int().min(61) }).safeParse(await result.json());
    if (!result.ok || !body.success) throw new Error('Feishu did not grant the application a token');
    this.token = { token: body.data.tenant_access_token, until: Date.now() + body.data.expire * 1000 };
    return this.token.token;
  }
  private async request(path: string, method: 'POST' | 'PATCH', body: unknown) {
    const response = await this.fetcher(api + path, { method, redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: 'Bearer ' + await this.accessToken(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = z.object({ code: z.number(), data: z.unknown().optional() }).parse(await response.json());
    if (!response.ok || result.code !== 0) throw new Error(`Feishu card request failed (HTTP ${response.status}, code ${result.code})`);
    return result.data;
  }
  async send(key: string, email: string) {
    return z.object({ message_id: messageId }).parse(await this.request('/im/v1/messages?receive_id_type=open_id', 'POST', {
      receive_id: this.reviewer, msg_type: 'interactive', uuid: key, content: JSON.stringify(card(key, email, 'pending')),
    })).message_id;
  }
  async update(id: string, key: string, email: string, status: Status) {
    await this.request('/im/v1/messages/' + messageId.parse(id), 'PATCH', { content: JSON.stringify(card(key, email, status)) });
  }
}

export async function initializeFeishuCards(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.beta_feishu_cards (
    owner text NOT NULL, email_hash text NOT NULL, key uuid NOT NULL UNIQUE,
    message_id text UNIQUE, attempted_at timestamptz, reviewed_at timestamptz,
    checked_at timestamptz, finished boolean NOT NULL DEFAULT false, PRIMARY KEY(owner,email_hash))`);
}

function decrypt(key: string, encrypt: string): unknown {
  const bytes = Buffer.from(encrypt, 'base64');
  const cipher = createDecipheriv('aes-256-cbc', createHash('sha256').update(key).digest(), bytes.subarray(0, 16));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(16)), cipher.final()]).toString('utf8'));
}

export function feishuReviewHandler(db: Database, config: CallbackConfig) {
  return express().post(reviewCallbackPath, express.raw({ type: 'application/json', limit: '64kb', inflate: false }), async (req, res) => {
    if (!Buffer.isBuffer(req.body)) { res.sendStatus(400); return; }
    let envelope: unknown;
    try { envelope = JSON.parse(req.body.toString('utf8')); }
    catch { res.sendStatus(400); return; }
    const encrypted = encBody.safeParse(envelope).data;
    const headers = signatureHeaders.safeParse({ timestamp: req.get('X-Lark-Request-Timestamp'),
      nonce: req.get('X-Lark-Request-Nonce'), signature: req.get('X-Lark-Signature') });
    let data: unknown;
    const authenticated = encrypted && headers.success && (() => {
      const { timestamp, nonce, signature } = headers.data;
      const receivedAt = Number(timestamp) * (timestamp.length === 10 ? 1000 : 1);
      const signed = createHash('sha256').update(timestamp + nonce + config.encryptKey).update(req.body).digest('hex');
      return eq(signature.toLowerCase(), signed) && Math.abs(Date.now() - receivedAt) <= 300000;
    })();
    try { data = encrypted ? decrypt(config.encryptKey, encrypted.encrypt) : envelope; }
    catch { res.sendStatus(401); return; }
    const verify = challenge.safeParse(data);
    if (verify.success && eq(verify.data.token, config.verificationToken)) { res.json({ challenge: verify.data.challenge }); return; }
    if (!authenticated) { res.sendStatus(401); return; }
    const click = signedEvent.safeParse(data);
    if (!click.success || click.data.header.app_id !== config.appId ||
        !eq(click.data.header.token, config.verificationToken)) { res.sendStatus(401); return; }
    if (click.data.event.operator.open_id !== config.reviewerOpenId) {
      res.json(toast('这张卡片需要由指定审核人操作', 'error')); return;
    }
    const { context, action } = click.data.event, s = db.schema;
    try {
      const result = await db.transaction(async client => {
        await db.query("SET LOCAL statement_timeout='1500ms'", [], client);
        return db.query<{ finished: boolean }>(`UPDATE ${s}.beta_feishu_cards c
          SET reviewed_at=COALESCE(c.reviewed_at,now())
          FROM ${s}.account_applications a
          WHERE c.key=$1 AND c.message_id=$2 AND a.owner=c.owner AND a.email_hash=c.email_hash
          RETURNING c.finished`, [action.value.key, context.open_message_id], client);
      });
      res.json(result.rowCount
        ? toast(result.rows[0]?.finished ? '已处理，请查看卡片状态' : '已收到批准，正在开通')
        : toast('申请已变更或卡片正在同步，请稍后重试', 'error'));
    } catch {
      res.status(503).json(toast('暂时无法记录批准，请重试', 'error'));
    }
  });
}

export async function syncFeishuCards(db: Database, bot: FeishuReviewCards) {
  const accounts = new Accounts(db, 'invite'), s = db.schema, ledger = `${s}.beta_feishu_cards`;
  const rows = (await db.query<Entry>(`SELECT q.owner,q.email,q.email_hash
    FROM ${s}.account_applications q LEFT JOIN ${s}.accounts a ON a.owner=q.owner
    LEFT JOIN ${ledger} c ON c.owner=q.owner AND c.email_hash=q.email_hash
    WHERE (a.owner IS NULL AND (c.message_id IS NULL OR c.reviewed_at IS NOT NULL)
           OR a.owner IS NOT NULL AND c.message_id IS NOT NULL)
      AND NOT COALESCE(c.finished,false)
      AND (c.message_id IS NOT NULL OR c.attempted_at IS NULL OR c.attempted_at>now()-interval '50 minutes')
    ORDER BY c.checked_at NULLS FIRST,q.applied_at,q.owner LIMIT 25`)).rows;
  let failures = 0, sent = 0, updated = 0;
  for (const entry of rows) {
    const keys = [entry.owner, entry.email_hash];
    const item = (await db.query<{ key: string }>(`INSERT INTO ${ledger}(owner,email_hash,key,checked_at) VALUES($1,$2,$3,now())
      ON CONFLICT(owner,email_hash) DO UPDATE SET checked_at=now() RETURNING key`, [...keys, randomUUID()])).rows[0]!;
    try {
      const effect = await db.transaction(async client => {
        const locking = await db.query<{ held: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS held',
          [db.lockKey('beta-feishu-card', item.key)], client);
        if (!locking.rows[0]?.held) return;
        const row = (await db.query<CardRow>(`SELECT * FROM ${ledger} WHERE owner=$1 AND email_hash=$2`, keys, client)).rows[0]!;
        if (row.finished) return;
        if (!row.message_id) {
          const attempt = await db.query(`UPDATE ${ledger} SET attempted_at=COALESCE(attempted_at,now())
            WHERE owner=$1 AND email_hash=$2 AND (attempted_at IS NULL OR attempted_at>now()-interval '50 minutes')`, keys);
          if (!attempt.rowCount) return;
          const id = await bot.send(row.key, entry.email);
          await db.query(`UPDATE ${ledger} SET message_id=$3 WHERE owner=$1 AND email_hash=$2`, [...keys, id], client);
          return 'sent';
        }
        let account = await accounts.account(entry.owner, client);
        if (!account && row.reviewed_at) {
          if (!await accounts.approveApplication(entry.owner, entry.email)) throw new Error('The application changed before approval');
          account = await accounts.account(entry.owner, client);
        }
        if (!account) return;
        const active = account.status === 'active' && account.email_hash === entry.email_hash;
        await bot.update(row.message_id, row.key, entry.email, active ? 'active' : 'closed');
        await db.query(`UPDATE ${ledger} SET finished=true WHERE owner=$1 AND email_hash=$2`, keys, client);
        return 'updated';
      });
      if (effect === 'sent') sent++;
      if (effect === 'updated') updated++;
    } catch {
      failures++;
      console.error('Feishu Beta card requires retry or review', item.key);
    }
  }
  return { inspected: rows.length, sent, updated, failures };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || process.env.EIGOS_SIGNUP !== 'invite') throw new Error('Configure DATABASE_URL and EIGOS_SIGNUP=invite');
  const db = new Database(databaseUrl, process.env.EIGOS_PG_SCHEMA);
  try {
    if (process.argv.includes('--initialize')) { await initializeFeishuCards(db); return; }
    const file = process.env.EIGOS_FEISHU_BETA_CARD_FILE;
    if (!file) throw new Error('Configure the Feishu Beta card credentials file');
    const config = installedConfig.parse(JSON.parse(await readPrivateSourceFile(file)));
    const read = async (path: string) => (await readPrivateSourceFile(path)).trim();
    const [secret, verificationToken, encryptKey] = await Promise.all([
      read(config.appSecretFile), read(config.verificationTokenFile), read(config.encryptKeyFile),
    ]);
    if (Math.min(secret.length, verificationToken.length, encryptKey.length) < 16) throw new Error('Feishu credentials are incomplete');
    const server = feishuReviewHandler(db, { ...config, verificationToken, encryptKey }).listen(config.port, '127.0.0.1');
    const bot = new FeishuReviewCards(config.appId, secret, config.reviewerOpenId);
    let stopped = false;
    const stop = () => { stopped = true; server.close(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    try {
      await new Promise<void>((ok, reject) => { server.once('listening', ok); server.once('error', reject); });
      while (!stopped) {
        const result = await syncFeishuCards(db, bot);
        if (result.sent || result.updated || result.failures) console.log(JSON.stringify(result));
        await delay(5000);
      }
    } finally { server.close(); }
  } finally { await db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Feishu Beta card service stopped'); process.exitCode = 1; });
}
