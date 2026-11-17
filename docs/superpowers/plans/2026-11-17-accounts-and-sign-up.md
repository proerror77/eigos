# 第 1 步：账号与注册 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 用户用 Google 或邮箱密码在 Auth0 自助注册后，自动开通 EIGOS 账号。同一个已验证邮箱只对应一个账号。现有的 Grok 连接照常可用。

**架构：** 在现有的会员实现上改造：

- `member_accounts` 改名为 `accounts`，并加上状态字段。
- `Members` 改为 `Accounts`：按开户模式自动开户，授权结果带上原因。
- 登录状态改放加密 cookie。
- `/account` 取代 `/members`。
- Auth0 Post-Login Action 负责三件事：邮箱检查、写入 tenant claim、合并同邮箱的账号。合并确认页放在 Gateway。

Grok 的「授权」按钮这一步保留，第 4 步再改成自动连接。

**技术栈：** TypeScript（Node ≥22.13，ESM）、Express、PostgreSQL、zod、jose、`node:test` + tsx、Auth0 Actions（Node 22，CommonJS）。

**设计依据：** `docs/superpowers/specs/2026-11-17-ontology-mcp-runtime-design.md` 第 6.2 节和第 7 节第 1 步。执行前两份都要读。

## Global Constraints

- 开发验收只做真实查询和 synthetic 执行：不写外部日历，不真实报名、下单或付款。
- owner 仍按 `digest([issuer, tenant, sub])` 计算，已有数据不迁移。
- 数据按 owner 分区。地点、店铺和供应商绑定不跨用户共享。
- 开户模式 `EIGOS_SIGNUP=open|invite|closed`，默认 `open`。`EIGOS_SIGNUP` 不是 `closed` 时，必须开启 `EIGOS_ENFORCE_OWNER_RLS=true`。
- 登录过程中的 state、nonce 和 PKCE verifier 放进加密、HttpOnly、5 分钟过期的 cookie。
- 没验证过邮箱的用户永远不合并，用户也不能跳过合并去另开一个账号。
- Auth0 租户上的改动是对外操作，必须等用户授权后才执行。
- 内部字段 `Principal.memberAudience`、`Principal.memberAccess` 和任务输入里的 `memberAccess` 不改名，因为它们已经存进了任务记录。
- 每个 PR 都要跑：`npm run check`、`npm run build`、`npm test`、构建后的 `npm run test:e2e:run`，以及 `git diff --check`。
- 测试数据库用自己创建的容器，命名为 `eigos-review-claude-<uuid>`，只停自己创建的容器。验证在 scratchpad 里的干净 `git archive` 导出中进行，先 `npm ci`。不碰用户自己的 checkout 和它的 `node_modules`。
- 凭据、数据库、真实供应商响应和临时材料放在仓库外或被忽略的目录里。
- 对用户的回复一律用中文。

## Review Focus

1. **开放注册时运营者登录账号页。** 有 Eigos 定义授权的 owner 不能被自动开户，否则他原有的客户端令牌会被当成账号令牌拒绝。测试放在 Task 2 和 Task 5。
2. **登录 cookie 被重放、篡改或已过期。** 一律跳到 `/account?status=login`，不能报 500。测试放在 Task 4 和 Task 5。
3. **撤销后重新授权 Grok。** 撤销之前签发的令牌必须继续被拒绝；重新授权之后签发的令牌可以用。测试放在 Task 2 和 Task 5。
4. **账号被停用时，已排队的任务。** 停用后，用这个账号身份加载的 `Access` 不能再拿到组授权，Worker 执行时就会被拒。测试放在 Task 2。
5. **Gateway 在反向代理后面。** 限流要按真实客户端地址分别计数，不能把所有用户当成同一个 IP。测试放在 Task 4。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `packages/runtime/accounts.ts`（由 `members.ts` 改名） | 账号表迁移、开户、会话、邀请、授权判定、停用与恢复 |
| `apps/gateway/account-portal.ts`（由 `member-login.ts` 改名） | Auth0 登录、账号页、合并确认页、重发验证信 |
| `apps/gateway/sealed-cookie.ts`（新） | AES-256-GCM 加密 cookie |
| `apps/gateway/rate-limit.ts`（新） | 按客户端地址的固定窗口限流 |
| `apps/gateway/auth0-management.ts`（新） | Auth0 Management API：重发验证信 |
| `deploy/auth0/post-login.cjs`（新） | Auth0 Post-Login Action |
| `scripts/account-command.ts`（新） | `account show|suspend|restore` 命令 |
| `tests/account-env.ts`（新） | 门户测试共用的环境变量 `portalEnv` |
| `tests/account-harness.ts`（新，从 35 号测试抽出） | 带模拟 Auth0 的 Gateway 测试工具 |
| `tests/37-accounts.test.ts`（新） | 配置、账号表、授权判定、授权组同步、运营者命令 |
| `tests/37-account-portal.test.ts`（新） | cookie、限流、账号页、Gateway 拒绝原因、合并页、重发验证信 |
| `tests/37-auth0-post-login.test.ts`（新） | Post-Login Action 单元测试 |
| `tests/35-account-mcp.test.ts`（由 `35-member-mcp.test.ts` 改名） | Grok 端到端流程 |
| `docs/guides/accounts.md`（由 `member-mcp.md` 改名） | 运营指南与部署清单 |

运行单组测试用 `npm test -- --suite=37`（35 号同理）。

---

### Task 1：配置项与校验

**Files:**
- Modify: `packages/core/config.ts:11-64`
- Modify: `tests/35-member-mcp.test.ts:43-48`（补上新的必填配置）
- Create: `tests/account-env.ts`
- Create: `tests/37-accounts.test.ts`

**Interfaces:**
- Produces（都加在 `configSchema` 上）：
  - `EIGOS_SIGNUP: 'open' | 'invite' | 'closed'`，默认 `'open'`；
  - `EIGOS_ENFORCE_OWNER_RLS?: 'true' | 'false'`；
  - `EIGOS_PORTAL_SECRET?: string`，至少 32 个字符；
  - `EIGOS_ACCOUNT_LINK_SECRET?: string`，至少 32 个字符；
  - `OAUTH_MANAGEMENT_CLIENT_ID?: string`，格式同其他 client ID；
  - `OAUTH_MANAGEMENT_CLIENT_SECRET?: string`；
  - `EIGOS_TRUST_PROXY?: string`。

- [ ] **Step 1：写失败的测试**

`portalEnv` 放在单独的 `tests/account-env.ts` 里。测试文件不能被别的文件导入，否则导入方也会跑一遍它的测试。

```ts
// tests/37-accounts.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readConfig } from '../packages/core/config.js';
import { portalEnv } from './account-env.js';

// tests/account-env.ts
export const portalEnv = {
  DATABASE_URL: 'postgres://synthetic', PUBLIC_URL: 'https://127.0.0.1',
  OAUTH_ISSUER: 'https://identity.example/', OAUTH_AUDIENCE: 'https://127.0.0.1',
  OAUTH_JWKS_URL: 'https://identity.example/.well-known/jwks.json',
  OAUTH_MEMBER_CLIENT_ID: 'portal', OAUTH_MEMBER_CLIENT_SECRET: 'synthetic-portal-secret',
  OAUTH_MEMBER_MCP_CLIENT_ID: 'grok', OAUTH_EXISTING_CLIENT_IDS: 'existing-client',
  EIGOS_PORTAL_SECRET: 'p'.repeat(32), EIGOS_ACCOUNT_LINK_SECRET: 'l'.repeat(32), EIGOS_ENFORCE_OWNER_RLS: 'true',
};

test('account portal configuration requires secrets and owner isolation for sign-up', () => {
  assert.equal(readConfig(portalEnv).EIGOS_SIGNUP, 'open');
  assert.throws(() => readConfig({ ...portalEnv, EIGOS_ENFORCE_OWNER_RLS: undefined }), /Self sign-up requires EIGOS_ENFORCE_OWNER_RLS=true/);
  assert.throws(() => readConfig({ ...portalEnv, EIGOS_SIGNUP: 'invite', EIGOS_ENFORCE_OWNER_RLS: 'false' }), /Self sign-up requires/);
  assert.equal(readConfig({ ...portalEnv, EIGOS_SIGNUP: 'closed', EIGOS_ENFORCE_OWNER_RLS: undefined }).EIGOS_SIGNUP, 'closed');
  assert.throws(() => readConfig({ ...portalEnv, EIGOS_PORTAL_SECRET: undefined }), /EIGOS_PORTAL_SECRET and EIGOS_ACCOUNT_LINK_SECRET/);
  assert.throws(() => readConfig({ ...portalEnv, EIGOS_ACCOUNT_LINK_SECRET: portalEnv.EIGOS_PORTAL_SECRET }), /separate portal and account link secrets/);
  assert.throws(() => readConfig({ ...portalEnv, OAUTH_MANAGEMENT_CLIENT_ID: 'm2m' }), /both OAUTH_MANAGEMENT_CLIENT_ID and OAUTH_MANAGEMENT_CLIENT_SECRET/);
  assert.throws(() => readConfig({ ...portalEnv, EIGOS_SIGNUP: 'everyone' }));
});
```

- [ ] **Step 2：运行测试，确认失败**

运行：`npm test -- --suite=37`
预期：FAIL。`EIGOS_SIGNUP` 是 `undefined`，或者某个 `assert.throws` 没有抛错。

- [ ] **Step 3：在 `configSchema` 里加上新字段，在 `readConfig` 现有的门户校验分支末尾加四条校验**

门户配置了（也就是进入了现有那段 `if (config.OAUTH_MEMBER_CLIENT_ID || ...)` 分支）时，依次检查：

| 条件 | 报错 |
|---|---|
| 缺 `EIGOS_PORTAL_SECRET` 或 `EIGOS_ACCOUNT_LINK_SECRET` | `Configure EIGOS_PORTAL_SECRET and EIGOS_ACCOUNT_LINK_SECRET for the account portal` |
| 两个 secret 相同 | `Use separate portal and account link secrets` |
| `EIGOS_SIGNUP !== 'closed'` 且 `EIGOS_ENFORCE_OWNER_RLS !== 'true'` | `Self sign-up requires EIGOS_ENFORCE_OWNER_RLS=true` |
| 两个 `OAUTH_MANAGEMENT_*` 只配了一个 | `Configure both OAUTH_MANAGEMENT_CLIENT_ID and OAUTH_MANAGEMENT_CLIENT_SECRET` |

- [ ] **Step 4：更新 35 号测试的配置**

在 `tests/35-member-mcp.test.ts` 的 `readConfig({...})` 里加上：

- `EIGOS_PORTAL_SECRET: 'p'.repeat(32)`
- `EIGOS_ACCOUNT_LINK_SECRET: 'l'.repeat(32)`
- `EIGOS_ENFORCE_OWNER_RLS: 'true'`
- `EIGOS_SIGNUP: 'invite'`

这个测试暂时继续覆盖邀请码流程。另外用 `grep -l OAUTH_MEMBER_CLIENT_ID tests` 找出其他配置了门户的测试，同样补上。

- [ ] **Step 5：运行测试，确认通过**

运行：`npm test -- --suite=37 && npm test -- --suite=35`
预期：PASS。

- [ ] **Step 6：提交**

```bash
git add packages/core/config.ts tests/account-env.ts tests/37-accounts.test.ts tests/35-member-mcp.test.ts
git commit -m "Require portal secrets and owner isolation for account sign-up"
```

---

### Task 2：账号表与 `Accounts`

**Files:**
- Rename: `packages/runtime/members.ts` → `packages/runtime/accounts.ts`（用 `git mv`）
- Modify: `packages/runtime/database.ts:24,188`（改为 `initializeAccounts`）
- Modify: `packages/runtime/access.ts:1,117-120`
- Modify: `apps/gateway/app.ts:29,71,76,96,114-122`，只做编译所需的最小改动：
  - `access === 'member'` 改为 `result.kind === 'account'`；
  - `access !== 'existing'` 改为 `result.kind !== 'existing'`；
  - 403 的内容先不动。
- Modify: `apps/gateway/member-login.ts`（imports；`activate` 的返回值改为字符串）
- Modify: `scripts/ontology.ts:18,43`
- Modify: `tests/35-member-mcp.test.ts:12,41,133`：改用 `Accounts`、`accountGroup`，以及 `new Accounts(f.db, 'invite')`。
- Test: `tests/37-accounts.test.ts`

**Interfaces:**
- Consumes：Task 1 的 `Config['EIGOS_SIGNUP']`
- Produces（`packages/runtime/accounts.ts`）：

```ts
export const accountGroup = 'eigos-accounts';
export const accountTaskScopes = ['tasks:read', 'tasks:write'] as const;
export type SignupMode = 'open' | 'invite' | 'closed';
export interface Account {
  owner: string; status: 'active' | 'suspended'; activated_at: Date; approved_at: Date | null; revoked_at: Date | null;
  suspended_at: Date | null; suspended_reason: string | null; email_hash: string | null;
}
export type ProvisionRefusal = 'signup_closed' | 'invite_required' | 'operator_account';
export type Denial = ProvisionRefusal | 'account_suspended' | 'client_not_allowed' | 'client_not_authorized' | 'insufficient_scope';
export type Authorization = { kind: 'account' } | { kind: 'existing' } | { kind: 'denied'; reason: Denial };
export const newAccountSecret: () => string;          // 原 newMemberSecret
export const emailDigest: (email: string) => string;   // 去空格、转小写后计算 digest
export async function initializeAccounts(db: Database): Promise<void>;
export class Accounts {
  constructor(db: Database, signup: SignupMode);
  invite(email: string, hours: number): Promise<string>;
  startSession(owner: string, email: string, previousToken: string): Promise<string>;
  session(token: string): Promise<{ owner: string; email_hash: string } | undefined>;
  endSession(token: string): Promise<void>;
  account(owner: string, client?: Sql): Promise<Account | undefined>;
  find(ownerOrEmail: string): Promise<Account | undefined>;
  isOperator(owner: string, client?: Sql): Promise<boolean>;     // 原私有方法 hasExistingGrant，改为公开
  provision(owner: string, emailHash?: string, client?: Sql): Promise<Account | ProvisionRefusal>;
  activate(session: { owner: string; email_hash: string }, code: string): Promise<'activated' | 'invalid' | 'operator_account'>;
  approve(owner: string): Promise<boolean>;
  revoke(owner: string): Promise<void>;
  suspend(owner: string, reason: string): Promise<boolean>;
  restore(owner: string): Promise<boolean>;
  active(owner: string, client: Sql): Promise<boolean>;
  authorize(principal: Principal, clientId: string, legacyClientIds: readonly string[]): Promise<Authorization>;
}
```

- [ ] **Step 1：写失败的测试**

把下面三个测试追加到 `tests/37-accounts.test.ts`，并补上 import：`fixture`、`setGrants`、`Access`、`Accounts`、`accountGroup`、`emailDigest`、`initializeAccounts`、`Principal`。

```ts
test('accounts provision by sign-up mode and keep operators out', async () => {
  const f = await fixture();
  try {
    const open = new Accounts(f.db, 'open');
    const alice = await open.provision('a'.repeat(64), emailDigest(' Alice@Example.test '));
    assert.equal(typeof alice === 'object' && alice.status, 'active');
    assert.equal(typeof alice === 'object' && alice.email_hash, emailDigest('alice@example.test'));
    assert.equal(await new Accounts(f.db, 'invite').provision('b'.repeat(64)), 'invite_required');
    assert.equal(await new Accounts(f.db, 'closed').provision('c'.repeat(64)), 'signup_closed');
    assert.equal(typeof await new Accounts(f.db, 'closed').provision('a'.repeat(64)), 'object');
    await setGrants(f.db, 'd'.repeat(64), [{ resource: 'Eigos', permission: 'view_definition' }]);
    assert.equal(await open.provision('d'.repeat(64)), 'operator_account');
    assert.equal(await open.account('d'.repeat(64)), undefined);
    assert.equal((await open.find('ALICE@example.test'))?.owner, 'a'.repeat(64));
    assert.equal((await open.find('a'.repeat(64)))?.owner, 'a'.repeat(64));
  } finally { await f.close(); }
});

test('authorization gives a reason, revocation can be undone and suspension removes group grants', async () => {
  const f = await fixture();
  try {
    const accounts = new Accounts(f.db, 'open'), owner = 'e'.repeat(64), now = Math.floor(Date.now() / 1000);
    const grok = (extra: Partial<Principal> = {}): Principal =>
      ({ owner, scopes: ['tasks:read', 'tasks:write'], clientId: 'grok', memberAudience: true, issuedAt: now, ...extra });
    assert.deepEqual(await accounts.authorize(grok(), 'grok', []), { kind: 'denied', reason: 'client_not_authorized' });
    assert.equal((await accounts.account(owner))?.status, 'active');
    assert.equal(await accounts.approve(owner), true);
    const first = (await accounts.account(owner))!.approved_at!;
    assert.deepEqual(await accounts.authorize(grok({ issuedAt: now + 5 }), 'grok', []), { kind: 'account' });
    assert.deepEqual(await accounts.authorize(grok({ issuedAt: now + 5, scopes: ['tasks:read'] }), 'grok', []), { kind: 'denied', reason: 'insufficient_scope' });
    assert.deepEqual(await accounts.authorize(grok({ issuedAt: now + 5, clientId: 'other' }), 'grok', []), { kind: 'denied', reason: 'client_not_allowed' });
    await accounts.revoke(owner);
    assert.deepEqual(await accounts.authorize(grok({ issuedAt: now + 5 }), 'grok', []), { kind: 'denied', reason: 'client_not_authorized' });
    assert.equal(await accounts.approve(owner), true);
    const again = (await accounts.account(owner))!;
    assert.equal(again.revoked_at, null);
    assert.ok(again.approved_at! > first);
    assert.deepEqual(await accounts.authorize(grok({ issuedAt: now - 3600 }), 'grok', []), { kind: 'denied', reason: 'client_not_authorized' });
    await setGrants(f.db, 'group:' + accountGroup, [{ resource: 'Eigos', permission: 'view_definition' }]);
    const asAccount = { owner, scopes: ['tasks:read'], memberAccess: true as const };
    const canView = async () => (await Access.load(f.db, asAccount)).allows({ ontology: 'Eigos', permission: 'view_definition', resource: 'Eigos' });
    assert.equal(await canView(), true);
    assert.equal(await accounts.suspend(owner, 'synthetic report'), true);
    assert.equal(await canView(), false);
    assert.deepEqual(await accounts.authorize(grok({ issuedAt: now + 5 }), 'grok', []), { kind: 'denied', reason: 'account_suspended' });
    assert.equal(await accounts.approve(owner), false);
    assert.equal(await accounts.restore(owner), true);
    assert.equal(await canView(), true);
    assert.deepEqual(await new Accounts(f.db, 'closed').authorize(grok({ owner: '0'.repeat(64) }), 'grok', []), { kind: 'denied', reason: 'signup_closed' });
    assert.deepEqual(await new Accounts(f.db, 'invite').authorize(grok({ owner: '1'.repeat(64) }), 'grok', []), { kind: 'denied', reason: 'invite_required' });
    await setGrants(f.db, '2'.repeat(64), [{ resource: 'Eigos', permission: 'view_definition' }]);
    assert.deepEqual(await accounts.authorize({ owner: '2'.repeat(64), scopes: [], clientId: 'existing-client' }, 'grok', ['existing-client']), { kind: 'existing' });
  } finally { await f.close(); }
});

test('initialization renames member accounts and moves member group grants', async () => {
  const f = await fixture();
  try {
    const s = f.db.schema;
    await f.db.query(`ALTER TABLE ${s}.accounts RENAME TO member_accounts`);
    await f.db.query(`INSERT INTO ${s}.member_accounts(owner,approved_at) VALUES($1,now())`, ['f'.repeat(64)]);
    await setGrants(f.db, 'group:eigos-member-queries', [{ resource: 'Eigos', permission: 'view_definition' }]);
    await initializeAccounts(f.db);
    const account = await new Accounts(f.db, 'open').account('f'.repeat(64));
    assert.equal(account?.status, 'active');
    assert.ok(account?.approved_at);
    const subjects = (await f.db.query(`SELECT DISTINCT subject FROM ${s}.resource_grants WHERE subject LIKE 'group:eigos-%'`)).rows.map(r => r.subject);
    assert.deepEqual(subjects, ['group:' + accountGroup]);
  } finally { await f.close(); }
});
```

- [ ] **Step 2：运行测试，确认失败**

运行：`npm test -- --suite=37`
预期：FAIL，原因是找不到模块 `../packages/runtime/accounts.js`。

- [ ] **Step 3：`git mv packages/runtime/members.ts packages/runtime/accounts.ts`，然后实现 `initializeAccounts` 的迁移**

`initializeAccounts` 依次执行下面的 SQL。这段 SQL 已经定下来，照写即可：

```sql
DO $$ BEGIN
  IF to_regclass('${s}.member_accounts') IS NOT NULL AND to_regclass('${s}.accounts') IS NULL THEN
    ALTER TABLE ${s}.member_accounts RENAME TO accounts;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS ${s}.accounts (
  owner text PRIMARY KEY, activated_at timestamptz NOT NULL DEFAULT now(), approved_at timestamptz, revoked_at timestamptz);
ALTER TABLE ${s}.accounts ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz, ADD COLUMN IF NOT EXISTS suspended_reason text,
  ADD COLUMN IF NOT EXISTS email_hash text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='accounts_status_check' AND conrelid='${s}.accounts'::regclass) THEN
    ALTER TABLE ${s}.accounts ADD CONSTRAINT accounts_status_check CHECK (status IN ('active','suspended'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS accounts_email ON ${s}.accounts(email_hash) WHERE email_hash IS NOT NULL;
-- member_invitations（redeemed_by 引用 accounts(owner)）和 member_sessions 的建表语句保持原样
INSERT INTO ${s}.resource_grants(subject,resource,permission)
  SELECT 'group:eigos-accounts',resource,permission FROM ${s}.resource_grants WHERE subject='group:eigos-member-queries'
  ON CONFLICT DO NOTHING;
DELETE FROM ${s}.resource_grants WHERE subject='group:eigos-member-queries';
```

`${s}` 是 `db.schema`。`database.ts:188` 改为调用 `initializeAccounts(this)`，这一行在 `resource_grants` 建表之后。

- [ ] **Step 4：实现 `Accounts` 的方法**

除了下面列出的规则，其余方法沿用原实现，只是把表名改成 `accounts`。

- **`provision`**：
  - 已有这一行时，传了 `emailHash` 就更新它，然后不论状态都返回这一行。
  - 没有这一行时：
    - `isOperator` 为真，返回 `'operator_account'`；
    - `open` 模式插入一行；
    - `invite` 模式返回 `'invite_required'`；
    - `closed` 模式返回 `'signup_closed'`。
- **`activate`**：
  - `closed` 模式返回 `'invalid'`；
  - 运营者返回 `'operator_account'`；
  - 账号已存在，返回 `'activated'`；
  - 其他情况按原来的邀请码逻辑处理，插入时写上 `email_hash`。
- **`approve`**：

  ```sql
  UPDATE accounts SET approved_at = CASE WHEN approved_at IS NOT NULL AND revoked_at IS NULL THEN approved_at ELSE now() END,
    revoked_at = NULL WHERE owner=$1 AND status='active'
  ```

  返回 `rowCount > 0`。
- **`suspend`**：`reason` 先 trim，长度要在 1 到 200 个字符之间。执行 `status='suspended', suspended_at=now(), suspended_reason=$2`，条件是 `WHERE owner=$1 AND status='active'`。
- **`restore`**：执行 `status='active', suspended_at=NULL, suspended_reason=NULL`，条件是 `WHERE owner=$1 AND status='suspended'`。
- **`active`**：在原条件上加 `status='active'`。
- **`find`**：参数匹配 `/^[a-f0-9]{64}$/` 时按 owner 查；否则按 `emailDigest` 查，有多行时取 `activated_at` 最新的一行。
- **`authorize`**，按顺序判断：
  1. 没有账号，且令牌同时满足 `memberAudience` 和 `clientId === clientId`：调用 `provision(owner)`。返回拒绝原因时，回 `{ kind: 'denied', reason }`。
  2. 有账号，或者令牌带 `memberAudience`，或者 `clientId === clientId`，按顺序检查：
     - 状态是 suspended，回 `account_suspended`；
     - 不同时满足 `memberAudience` 和 `clientId` 匹配，回 `client_not_allowed`；
     - 还没授权、已撤销，或者 `issuedAt < floor(approved_at / 1000)`，回 `client_not_authorized`；
     - scope 不全，回 `insufficient_scope`；
     - 都通过，回 `{ kind: 'account' }`。
  3. 其余情况走原来的旧客户端判断。有既有授权回 `{ kind: 'existing' }`，否则回 `{ kind: 'denied', reason: 'client_not_allowed' }`。

`access.ts:117-120` 的子查询改为：

```sql
subject=$2 AND EXISTS (SELECT 1 FROM ${s}.accounts WHERE owner=$1 AND status='active' AND approved_at IS NOT NULL AND revoked_at IS NULL)
```

其中 `$2` 是 `'group:' + accountGroup`。

- [ ] **Step 5：更新调用方，让编译通过**

按上面 Files 一节修改 `app.ts`、`member-login.ts`、`scripts/ontology.ts` 和 35 号测试。

运行：`npm run check`
预期：没有错误。

- [ ] **Step 6：运行测试，确认通过**

运行：`npm test -- --suite=37 && npm test -- --suite=35 && npm test -- --suite=16`
预期：PASS。

- [ ] **Step 7：提交**

```bash
git add -A packages/runtime apps/gateway scripts/ontology.ts tests
git commit -m "Turn member accounts into self-service accounts with status and refusal reasons"
```

---

### Task 3：授权组同步与运营者命令

**Files:**
- Modify: `packages/runtime/access.ts:533-542`
- Create: `scripts/account-command.ts`
- Modify: `scripts/ontology.ts`
- Modify: `package.json`
- Modify: `tests/e2e/gateway.test.ts:10,25`
- Test: `tests/37-accounts.test.ts`

**Interfaces:**
- Consumes：Task 2 的 `Accounts`、`accountGroup`、`emailDigest`、`SignupMode`
- Produces：
  - `businessGrants(model: Ontology, sandboxEnabled?: boolean): Grant[]`：由 `memberGrants` 改名，函数体不变。
  - `syncAccountGrants(db: Database, model: Ontology, client?: Sql): Promise<void>`：等于 `setGrants(db, 'group:' + accountGroup, businessGrants(model, db.sandboxEnabled), client)`。
  - `accountCommand(db: Database, signup: SignupMode, args: readonly string[]): Promise<{ owner: string; status: string; activatedAt: string; approvedAt: string | null; revokedAt: string | null; suspendedAt: string | null; suspendedReason: string | null }>`
- CLI 命令（`scripts/ontology.ts`）：

  | 命令 | 说明 |
  |---|---|
  | `account show <owner\|email>` | 查看账号 |
  | `account suspend <owner\|email> <理由…>` | 停用账号 |
  | `account restore <owner\|email>` | 恢复账号 |
  | `invite <email> [hours]` | 发邀请码，原名 `invite-member` |
  | `grant-business <owner>` | 给 owner 全部业务授权，原名 `grant-member` |

  - `publish` 和 `activate` 成功后，对已激活的 `PublishedOntology` 调用 `syncAccountGrants`。
  - 不认识的命令，报错信息里的命令列表要同步更新。
- npm scripts：
  - 删除 `access:invite-member` 和 `access:grant-member`；
  - 新增 `account:invite`（`… scripts/ontology.ts invite`）、`access:grant-business`（`… grant-business`）、`account`（`… scripts/ontology.ts account`）。

- [ ] **Step 1：写失败的测试**

```ts
test('account grants follow the published business resources', async () => {
  const f = await fixture();
  try {
    await syncAccountGrants(f.db, f.model);
    const rows = (await f.db.query(`SELECT resource,permission FROM ${f.db.schema}.resource_grants WHERE subject=$1`, ['group:' + accountGroup])).rows;
    assert.deepEqual(new Set(rows.map(r => r.permission + ':' + r.resource)),
      new Set(businessGrants(f.model, f.db.sandboxEnabled).map(g => g.permission + ':' + g.resource)));
    assert.ok(rows.every(r => !['edit_definition', 'manage_definition'].includes(r.permission)));
  } finally { await f.close(); }
});

test('operator account commands find accounts by owner or email', async () => {
  const f = await fixture();
  try {
    const owner = '3'.repeat(64), accounts = new Accounts(f.db, 'open');
    await accounts.provision(owner, emailDigest('carol@example.test'));
    assert.equal((await accountCommand(f.db, 'open', ['show', 'Carol@example.test'])).status, 'active');
    assert.equal((await accountCommand(f.db, 'open', ['suspend', owner, 'synthetic', 'report'])).status, 'suspended');
    assert.equal((await accounts.account(owner))?.suspended_reason, 'synthetic report');
    assert.equal((await accountCommand(f.db, 'open', ['restore', owner])).status, 'active');
    await assert.rejects(accountCommand(f.db, 'open', ['show', 'nobody@example.test']), /Account not found/);
    await assert.rejects(accountCommand(f.db, 'open', ['suspend', owner]), /Provide a suspension reason/);
    await assert.rejects(accountCommand(f.db, 'open', ['delete', owner]), /Use account show, suspend or restore/);
  } finally { await f.close(); }
});
```

- [ ] **Step 2：运行测试，确认失败**

运行：`npm test -- --suite=37`
预期：FAIL，原因是 `syncAccountGrants`、`accountCommand` 没有导出。

- [ ] **Step 3：实现 `businessGrants`、`syncAccountGrants`、`accountCommand`，并接入 `scripts/ontology.ts`**

`accountCommand` 的报错文案：

| 情况 | 报错 |
|---|---|
| 找不到账号 | `Account not found` |
| suspend 缺理由 | `Provide a suspension reason` |
| 子命令不对 | `Use account show, suspend or restore` |

理由由第 3 个及之后的参数用空格拼接而成。

- [ ] **Step 4：重命名调用方**

全仓搜索 `memberGrants`，改为 `businessGrants`（包括 `tests/e2e/gateway.test.ts`）。然后修改 `package.json`。

运行：`grep -rn "memberGrants\|grant-member\|invite-member" apps packages scripts tests package.json`
预期：没有输出。

- [ ] **Step 5：运行测试，确认通过**

运行：`npm run check && npm test -- --suite=37`
预期：PASS。

- [ ] **Step 6：提交**

```bash
git add packages/runtime/access.ts scripts package.json tests
git commit -m "Sync the account group with published business grants and add operator account commands"
```

---

### Task 4：加密 cookie 与按地址限流

**Files:**
- Create: `apps/gateway/sealed-cookie.ts`
- Create: `apps/gateway/rate-limit.ts`
- Test: `tests/37-account-portal.test.ts`

**Interfaces:**
- Produces：

```ts
// sealed-cookie.ts
export function seal(secret: string, purpose: string, value: unknown, ttlMs: number, now?: number): string;
export function unseal<T>(secret: string, purpose: string, sealed: string, schema: z.ZodType<T>, now?: number): T | undefined;
// rate-limit.ts
export function rateLimit(options: { windowMs: number; max: number; maxKeys?: number }): express.RequestHandler;
```

**加密格式**（照做）：

- 密钥用 HKDF-SHA256 派生：输入是 `secret`，salt 是 `'eigos-sealed-cookie'`，info 是 `purpose`，长度 32 字节。
- 明文是 JSON：`{ v: value, exp: now + ttlMs }`。
- 加密用 AES-256-GCM：随机 12 字节 IV，AAD 设为 `purpose`。
- 输出是 base64url(IV ‖ 密文 ‖ 16 字节 tag)。
- `unseal` 只要遇到以下任何情况都返回 `undefined`，从不抛错：
  - 长度超过 4096；
  - 解码失败或认证失败；
  - `purpose` 不对；
  - 已过期；
  - 不符合 schema。

**限流规则**：

- 按 `req.ip` 做固定窗口计数，超出时返回 429。
- 响应头 `Retry-After` 是剩余的秒数，响应正文是 `请求过于频繁，请稍后再试。`。
- `maxKeys` 默认 10 000。记录满了，先删过期的窗口；还是满，就删最早插入的那个。

- [ ] **Step 1：写失败的测试**

```ts
test('sealed cookies reject tampering, other purposes and expiry', () => {
  const secret = 's'.repeat(32), schema = z.strictObject({ state: z.string() });
  const sealed = seal(secret, 'login', { state: 'abc' }, 300_000, 1_000);
  assert.deepEqual(unseal(secret, 'login', sealed, schema, 2_000), { state: 'abc' });
  assert.equal(unseal(secret, 'link', sealed, schema, 2_000), undefined);
  assert.equal(unseal('t'.repeat(32), 'login', sealed, schema, 2_000), undefined);
  assert.equal(unseal(secret, 'login', sealed, schema, 301_001), undefined);
  const flipped = sealed.slice(0, 20) + (sealed[20] === 'A' ? 'B' : 'A') + sealed.slice(21);
  assert.equal(unseal(secret, 'login', flipped, schema, 2_000), undefined);
  assert.equal(unseal(secret, 'login', 'not-a-cookie', schema, 2_000), undefined);
});

test('rate limit counts each client address separately behind a trusted proxy', async () => {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.get('/limited', rateLimit({ windowMs: 60_000, max: 2 }), (_req, res) => res.send('ok'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const from = (ip: string) => fetch(`http://127.0.0.1:${port}/limited`, { headers: { 'X-Forwarded-For': ip } });
  try {
    assert.deepEqual([(await from('198.51.100.1')).status, (await from('198.51.100.1')).status], [200, 200]);
    const limited = await from('198.51.100.1');
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal((await from('198.51.100.2')).status, 200);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
```

- [ ] **Step 2：运行测试，确认失败**

运行：`npm test -- --suite=37`
预期：FAIL，原因是找不到模块 `../apps/gateway/sealed-cookie.js`。

- [ ] **Step 3：按上面的格式和规则实现两个模块**

- [ ] **Step 4：运行测试，确认通过**

运行：`npm test -- --suite=37`
预期：PASS。

- [ ] **Step 5：提交**

```bash
git add apps/gateway/sealed-cookie.ts apps/gateway/rate-limit.ts tests/37-account-portal.test.ts
git commit -m "Add sealed cookies and per-address rate limiting for the account portal"
```

---

### Task 5：账号页 `/account`

**Files:**
- Rename: `apps/gateway/member-login.ts` → `apps/gateway/account-portal.ts`（用 `git mv`）
- Modify: `apps/gateway/app.ts`：挂载门户、`/` 跳转、`trust proxy`、把 provider 参数 `memberLogin` 改名为 `accountLogin`。
- Create: `tests/account-harness.ts`：从 35 号测试里抽出 JWT 签名、模拟 Auth0 code 交换、登录和表单这几个辅助函数。
- Rename: `tests/35-member-mcp.test.ts` → `tests/35-account-mcp.test.ts`，改用 harness，路径改为 `/account`。
- Test: `tests/37-account-portal.test.ts`

**Interfaces:**
- Consumes：
  - Task 2 的 `Accounts`、`emailDigest`、`newAccountSecret`；
  - Task 4 的 `seal`、`unseal`、`rateLimit`。
- Produces：

```ts
// account-portal.ts
export type LoginAttempt = { state: string; nonce: string; verifier: string; link?: { auth0State: string; subject: string; primary: string } };
export type LoginResult =
  | { kind: 'verified'; owner: string; email: string; subject: string }
  | { kind: 'unverified'; subject: string }
  | { kind: 'tenant_missing' };
export function auth0AccountLogin(config: Config, exchange?: typeof fetch, keys?: JWTVerifyGetKey): {
  start(attempt: LoginAttempt, options: { signup: boolean; connection?: string; linking?: boolean }): URL;
  finish(code: string, attempt: LoginAttempt): Promise<LoginResult>;
};
export function mountAccountPortal(app: express.Express, config: Config, accounts: Accounts,
  login?: ReturnType<typeof auth0AccountLogin>): void;

// tests/account-harness.ts
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export interface AccountGateway {
  url: string; config: Config; accounts: Accounts;
  owner(sub: string): string;
  token(sub: string, options?: { azp?: string; aud?: string; scope?: string; issuedAt?: number }): Promise<string>;
  login(sub: string, email: string, options?: { verified?: boolean; tenant?: boolean; wrongState?: boolean; start?: string; startCookie?: string }):
    Promise<{ location: string | null; cookie: string; response: Response; replay: Response }>;
  form(path: string, cookie: string, body?: URLSearchParams, origin?: string): Promise<Response>;
  call(path: string, accessToken?: string): Promise<Response>;
  page(cookie: string): Promise<string>;
  close(): Promise<void>;
}
export async function accountGateway(f: Fixture, options?: { signup?: SignupMode; env?: Record<string, string> }): Promise<AccountGateway>;
```

**harness 里固定的值**：

| 项 | 值 |
|---|---|
| issuer | `https://identity.example/` |
| `PUBLIC_URL` | `https://127.0.0.1` |
| MCP audience | `https://127.0.0.1/mcp` |
| tenant | `personal` |
| 客户端 ID | `portal`、`grok`、`existing-client` |
| 环境变量 | 和 Task 1 的 `portalEnv` 相同，另加 `EIGOS_SIGNUP` |

- 模拟 Auth0 每次登录发一个唯一的 code。同一个 code 第二次交换时返回 400，和真实的 Auth0 一样。
- `options.tenant === false` 时，签出的 ID token 不带 `tenant_id`。

**路由与 cookie**：

| 路由 | 说明 |
|---|---|
| GET `/account` | 账号页 |
| GET `/account/login[?signup=1]` | 发起登录；同一地址每分钟最多 20 次 |
| GET `/account/callback` | 登录回调；同一地址每分钟最多 20 次 |
| POST `/account/activate`、`/approve`、`/revoke`、`/logout` | 检查 Origin，需要会话；同一地址每分钟最多 30 次 |
| GET `/members`、`/members/*`、`/` | 302 跳到 `/account` |

限流计数器分三组：

- GET `/account/login`、`/account/callback`、`/account/link`、`/account/link/continue` 共用一个，同一地址每分钟最多 20 次；
- 所有 POST 共用一个，同一地址每分钟最多 30 次；
- `/account/resend-verification` 单独一个，同一地址每小时最多 5 次（Task 9）。

账号页上的另外几块内容在后面的步骤里加入：来源连接是第 2 步，A2A 地址是第 4 步，待确认事项是第 5 步。

| cookie | 内容 |
|---|---|
| `__Host-eigos-account` | 会话，8 小时，沿用 `member_sessions` |
| `__Host-eigos-account-login` | 加密的 `LoginAttempt`，purpose 为 `'login'`，5 分钟过期 |

**`finish`**：

- 验证 ID token 时，`requiredClaims` 只要 `['sub', 'iat', 'exp', 'nonce']`。
- 验证通过后单独检查 `payload[OAUTH_TENANT_CLAIM]`：不是非空字符串，就返回 `{ kind: 'tenant_missing' }`。

**callback**：

1. 解开登录 cookie，然后清掉它。
2. 校验 state 和 code（code 长度 1 到 3000），不通过就跳 `?status=login`。`finish` 抛错时也跳 `?status=login`。
3. 按 `finish` 的结果处理：

   | 结果 | 处理 |
   |---|---|
   | `tenant_missing` | 跳 `?status=tenant` |
   | `unverified` | 结束旧会话，跳 `?status=verify` |
   | `verified` | 调用 `accounts.provision(owner, emailDigest(email))`，然后开启会话 |

4. `verified` 时再按开户结果跳转：

   | 开户结果 | 跳转 |
   |---|---|
   | 账号 | `/account` |
   | `invite_required` | `/account` |
   | `signup_closed` | `/account?status=closed` |
   | `operator_account` | `/account?status=operator` |

**状态文案**（照抄）：

```ts
const statuses = {
  login: '登录没有完成，请重新登录。',
  verify: '请先打开 Auth0 发到你邮箱的验证邮件，验证后再重新登录。',
  tenant: '登录服务的配置不完整，缺少租户信息，请联系 EIGOS 支持。',
  closed: '目前暂停注册新账号。',
  invite: '邀请码无效、已过期，或者和已验证的邮箱不一致。',
  operator: '这是运营者账号，不需要开通，请继续使用原来的客户端。',
  origin: '请回到账号页重新提交。',
} as const;
```

**页面**（标题和 h1 都是 `EIGOS 账号`）：

| 状态 | 显示内容 |
|---|---|
| 未登录 | `注册 · 登录` 两个链接 |
| 已登录、没有账号、运营者 | 运营者文案 |
| 已登录、没有账号、`invite` 模式 | 邀请码表单，按钮 `开通账号` |
| 已登录、没有账号、`closed` 模式 | 暂停注册文案 |
| 已登录、没有账号、`open` 模式 | `账号还没有开通，请重新登录。` |
| 已停用 | `这个账号已停用，请联系 EIGOS 支持。` |
| 已撤销 | `已撤销 Grok 的访问，需要时可以重新授权。` 和按钮 `重新授权 Grok` |
| 已授权 | 原有的 MCP 地址和 Client ID，以及按钮 `撤销 Grok 授权` |
| 已开通、还没授权 | `账号已开通。授权后，Grok 可以提交和读取你自己的查询任务。` 和按钮 `授权 Grok` |

已登录时，页面底部都有按钮 `退出登录`。

- [ ] **Step 1：写失败的测试（追加到 `tests/37-account-portal.test.ts`）**

```ts
test('open sign-up provisions a verified account at the first portal login', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'open' });
  try {
    const alice = await g.login('alice', 'alice@example.test');
    assert.equal(alice.location, '/account');
    assert.equal(alice.replay.headers.get('location'), '/account?status=login');
    assert.equal((await g.accounts.account(g.owner('alice')))?.status, 'active');
    assert.match(await g.page(alice.cookie), /授权 Grok/);
  } finally { await g.close(); await f.close(); }
});

test('sign-up modes, operators and identity problems each show their own status', async () => {
  const f = await fixture();
  const closed = await accountGateway(f, { signup: 'closed' }), invite = await accountGateway(f, { signup: 'invite' }), open = await accountGateway(f, { signup: 'open' });
  try {
    assert.equal((await closed.login('bob', 'bob@example.test')).location, '/account?status=closed');
    assert.equal(await closed.accounts.account(closed.owner('bob')), undefined);
    const carol = await invite.login('carol', 'carol@example.test');
    assert.match(await invite.page(carol.cookie), /开通账号/);
    assert.equal((await invite.form('activate', carol.cookie, new URLSearchParams({ code: 'x'.repeat(43) }))).headers.get('location'), '/account?status=invite');
    await setGrants(f.db, open.owner('operator'), [{ resource: 'Eigos', permission: 'view_definition' }]);
    assert.equal((await open.login('operator', 'ops@example.test')).location, '/account?status=operator');
    assert.equal(await open.accounts.account(open.owner('operator')), undefined);
    assert.equal((await open.login('dan', 'dan@example.test', { verified: false })).location, '/account?status=verify');
    assert.equal((await open.login('erin', 'erin@example.test', { tenant: false })).location, '/account?status=tenant');
    assert.equal((await open.login('erin', 'erin@example.test', { wrongState: true })).location, '/account?status=login');
    const tampered = await fetch(open.url + '/account/callback?code=c&state=s', { redirect: 'manual', headers: { Cookie: '__Host-eigos-account-login=' + 'A'.repeat(120) } });
    assert.equal(tampered.headers.get('location'), '/account?status=login');
  } finally { await closed.close(); await invite.close(); await open.close(); await f.close(); }
});

test('revoked Grok access can be authorized again and old addresses redirect', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'open' });
  try {
    const { cookie } = await g.login('frank', 'frank@example.test');
    await g.form('approve', cookie);
    await g.form('revoke', cookie);
    assert.match(await g.page(cookie), /重新授权 Grok/);
    await g.form('approve', cookie);
    assert.match(await g.page(cookie), /撤销 Grok 授权/);
    for (const path of ['/members', '/members/login', '/'])
      assert.equal((await fetch(g.url + path, { redirect: 'manual' })).headers.get('location'), '/account');
    const statuses = [];
    for (let i = 0; i < 21; i++) statuses.push((await fetch(g.url + '/account/login', { redirect: 'manual' })).status);
    assert.equal(statuses.at(-1), 429);
  } finally { await g.close(); await f.close(); }
});
```

- [ ] **Step 2：运行测试，确认失败**

运行：`npm test -- --suite=37`
预期：FAIL，原因是找不到模块 `./account-harness.js` 或 `../apps/gateway/account-portal.js`。

- [ ] **Step 3：`git mv apps/gateway/member-login.ts apps/gateway/account-portal.ts`，按上面的规则改写登录、回调、页面和跳转**

- [ ] **Step 4：在 `app.ts` 里接上新的门户**

改为调用 `mountAccountPortal(app, config, accounts, accountLogin)`。

`/` 跳到 `/account`。配置了 `EIGOS_TRUST_PROXY` 时，执行 `app.set('trust proxy', /^\d+$/.test(v) ? Number(v) : v)`。

- [ ] **Step 5：抽出 `tests/account-harness.ts`，改写 35 号测试并改名**

`git mv tests/35-member-mcp.test.ts tests/35-account-mcp.test.ts`。35 号测试改用 harness，固定 `signup: 'invite'`，所有 `/members` 路径换成 `/account`。

文件末尾那段「撤销后重新授权」改成：

- 旧令牌仍然返回 403；
- 重新授权之后签发的新令牌返回 200。

- [ ] **Step 6：运行测试，确认通过**

运行：`npm run check && npm test -- --suite=37 && npm test -- --suite=35`
预期：PASS。

- [ ] **Step 7：提交**

```bash
git add -A apps/gateway tests
git commit -m "Serve the account page with open sign-up, distinct statuses and reversible Grok authorization"
```

---

### Task 6：Gateway 的拒绝原因

**Files:**
- Modify: `apps/gateway/app.ts:66-123`
- Test: `tests/37-account-portal.test.ts`

**Interfaces:**
- Consumes：Task 2 的 `Authorization`、`Denial`；Task 5 的 harness。
- Produces：被拒绝时返回 403，JSON 是 `{ error: string; reason: Denial; account: '/account' }`。

**`error` 文案**（照抄，给机器客户端看，用英文）：

```ts
const refusal: Record<Denial, string> = {
  signup_closed: 'EIGOS sign-up is closed',
  invite_required: 'Redeem an EIGOS invitation on the account page first',
  operator_account: 'Operator accounts use their existing client',
  account_suspended: 'This EIGOS account is suspended',
  client_not_allowed: 'This client is not allowed for EIGOS accounts',
  client_not_authorized: 'Authorize this client on the EIGOS account page',
  insufficient_scope: 'The token is missing tasks:read or tasks:write',
};
```

`insufficient_scope` 的响应还要另加一个响应头：

```
WWW-Authenticate: Bearer error="insufficient_scope", scope="tasks:read tasks:write", resource_metadata="<PUBLIC_URL>/.well-known/oauth-protected-resource/mcp"
```

- [ ] **Step 1：写失败的测试**

```ts
test('gateway explains why an account token is refused', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'open' }), closed = await accountGateway(f, { signup: 'closed' });
  try {
    const first = await g.call('/mcp', await g.token('gina'));
    assert.equal(first.status, 403);
    assert.deepEqual(await first.json(), { error: 'Authorize this client on the EIGOS account page', reason: 'client_not_authorized', account: '/account' });
    assert.equal((await g.accounts.account(g.owner('gina')))?.status, 'active');
    await g.accounts.approve(g.owner('gina'));
    const later = Math.floor(Date.now() / 1000) + 5;
    const narrow = await g.call('/mcp', await g.token('gina', { scope: 'tasks:read', issuedAt: later }));
    assert.equal(narrow.status, 403);
    assert.match(narrow.headers.get('www-authenticate')!, /error="insufficient_scope", scope="tasks:read tasks:write"/);
    await g.accounts.suspend(g.owner('gina'), 'synthetic');
    assert.equal((await (await g.call('/mcp', await g.token('gina', { issuedAt: later }))).json()).reason, 'account_suspended');
    assert.equal((await (await closed.call('/mcp', await closed.token('hank'))).json()).reason, 'signup_closed');
  } finally { await g.close(); await closed.close(); await f.close(); }
});
```

- [ ] **Step 2：运行测试，确认失败**

运行：`npm test -- --suite=37`
预期：FAIL，因为响应正文还是旧的 `Active EIGOS membership…`。

- [ ] **Step 3：在中间件里按 `Authorization` 返回拒绝原因**

`kind === 'account'` 时，原有的「只允许 `/mcp`、`/identity`」限制和强制 scope 保持不变。

- [ ] **Step 4：运行测试，确认通过**

运行：`npm test -- --suite=37 && npm test -- --suite=35`
预期：PASS。

- [ ] **Step 5：提交**

```bash
git add apps/gateway/app.ts tests/37-account-portal.test.ts
git commit -m "Tell agents why an account token was refused"
```

---

### Task 7：Auth0 Post-Login Action

**Files:**
- Create: `deploy/auth0/post-login.cjs`
- Test: `tests/37-auth0-post-login.test.ts`

**Interfaces:**
- Produces：

```js
// deploy/auth0/post-login.cjs（CommonJS，运行在 Auth0 Node 22 上，不依赖任何 npm 包）
exports.createPostLogin = ({ fetch }) => ({ onExecutePostLogin, onContinuePostLogin });
exports.onExecutePostLogin = /* createPostLogin({ fetch: globalThis.fetch }).onExecutePostLogin */;
exports.onContinuePostLogin = /* 同上 */;
```

**Action secrets**（都从 `event.secrets` 读取）：

| 名称 | 说明 |
|---|---|
| `EIGOS_AUDIENCES` | 用逗号分隔的 API identifier |
| `TENANT_CLAIM` | 默认 `tenant_id` |
| `TENANT_METADATA_KEY` | 默认 `tenant_id` |
| `DEFAULT_TENANT` | 新用户的 tenant |
| `LINK_URL` | `https://<gateway>/account/link` |
| `LINK_SECRET` | 等于 `EIGOS_ACCOUNT_LINK_SECRET` |
| `MANAGEMENT_DOMAIN`、`MANAGEMENT_CLIENT_ID`、`MANAGEMENT_CLIENT_SECRET` | Management API 凭据 |

**`onExecutePostLogin`**，按顺序执行：

1. `eigosApi` 表示 `event.resource_server?.identifier` 是否在 `EIGOS_AUDIENCES` 里。如果 `eigosApi` 为真且 `event.user.email_verified !== true`，执行 `api.access.deny('请先验证邮箱，再连接 EIGOS。')` 并结束。
2. 从 `app_metadata[TENANT_METADATA_KEY]` 取 tenant。取不到非空字符串时，用 `DEFAULT_TENANT`，并执行 `api.user.setAppMetadata(TENANT_METADATA_KEY, DEFAULT_TENANT)`。
3. 同时满足下面四个条件时，检查有没有要合并的账号：
   - `event.transaction?.protocol !== 'oauth2-refresh-token'`；
   - `event.request?.query?.eigos_link !== '1'`；
   - 邮箱已验证；
   - `event.user.identities.length === 1`。

   检查步骤：
   1. 用 client credentials 取 Management token，用 `api.cache` 缓存，到 `expires_in - 60` 秒为止。
   2. 请求 `GET /api/v2/users-by-email?email=`。
   3. 在结果里找另一个用户：`user_id` 不同、邮箱已验证、`created_at` 更早。找到多个时，取最早创建的那个，记为 `older`。
   4. 找到 `older` 时，执行下面的跳转，然后结束，这时不写 claim：

      ```js
      api.redirect.sendUserTo(LINK_URL, { query: { session_token: api.redirect.encodeToken({
        secret: LINK_SECRET, expiresInSeconds: 300,
        payload: { primary: older.user_id, connection: older.identities[0].connection } }) } })
      ```

4. 执行 `api.idToken.setCustomClaim(TENANT_CLAIM, tenant)`。`eigosApi` 为真时，再执行 `api.accessToken.setCustomClaim(TENANT_CLAIM, tenant)`。

**`onContinuePostLogin`**，按顺序执行：

1. 用 `api.redirect.validateToken({ secret: LINK_SECRET, tokenParameterName: 'session_token' })` 取出 payload，读取 `primary`。
2. 请求 `GET /api/v2/users/{primary}`，必须同时满足：邮箱已验证；邮箱和当前用户相同（不区分大小写）；比当前用户创建得早。否则执行 `api.access.deny('合并没有完成，请用原来的方式重新登录。')`。
3. 请求 `POST /api/v2/users/{primary}/identities`，body 是 `{ provider: event.user.identities[0].provider, user_id: event.user.identities[0].user_id }`。返回不是 2xx 时，用同一句文案拒绝。
4. 执行 `api.authentication.setPrimaryUser(primary)`。
5. tenant 取 primary 的 `app_metadata`，取不到就用 `DEFAULT_TENANT`。claim 的写法和 execute 第 4 步相同。

- [ ] **Step 1：写失败的测试**

测试文件里放两个辅助函数：

- `fakeApi()` 记录这些调用：`deny`、`idToken`/`accessToken` 的 claim、`setAppMetadata`、`sendUserTo`、`setPrimaryUser`。
  - `encodeToken` 返回 `'encoded:' + JSON.stringify(payload)`；
  - `validateToken` 返回预先设好的 payload；
  - `cache` 用一个 Map 实现。
- `fakeManagement(users)` 模拟 `/oauth/token`、`/api/v2/users-by-email`、`/api/v2/users/{id}` 和 `/api/v2/users/{id}/identities`，并记录 link 请求的 body。

```ts
const require = createRequire(import.meta.url);
const { createPostLogin } = require('../deploy/auth0/post-login.cjs');
const secrets = { EIGOS_AUDIENCES: 'https://eigos.example/mcp,https://eigos.example', DEFAULT_TENANT: 'personal',
  LINK_URL: 'https://eigos.example/account/link', LINK_SECRET: 'l'.repeat(32),
  MANAGEMENT_DOMAIN: 'tenant.example', MANAGEMENT_CLIENT_ID: 'm2m', MANAGEMENT_CLIENT_SECRET: 'synthetic' };
const older = { user_id: 'google-oauth2|1', email: 'amy@example.test', email_verified: true, created_at: '2026-01-01T00:00:00Z',
  identities: [{ provider: 'google-oauth2', user_id: '1', connection: 'google-oauth2' }], app_metadata: { tenant_id: 'personal' } };
const newer = { user_id: 'auth0|2', email: 'amy@example.test', email_verified: true, created_at: '2026-11-17T00:00:00Z',
  identities: [{ provider: 'auth0', user_id: '2', connection: 'Username-Password-Authentication' }], app_metadata: {} };

test('unverified email cannot obtain an EIGOS API token', async () => { /* audience 是 https://eigos.example/mcp，用户未验证：调用了 deny，没有写任何 claim */ });
test('verified login gets the managed tenant claim', async () => { /* app_metadata.tenant_id='org-7' 时两个 token 都写 'org-7'；没有 tenant 的新用户写入 personal，并调用 setAppMetadata */ });
test('a newer identity with an older verified duplicate is sent to the EIGOS link page', async () => {
  /* 以 newer 登录：sendUserTo 的地址是 LINK_URL；session_token 是 'encoded:{"primary":"google-oauth2|1","connection":"google-oauth2"}'；没有写 claim */ });
test('no link redirect for unverified duplicates, refresh tokens or the link verification login', async () => { /* 三种情况都不调用 sendUserTo，都写了 claim */ });
test('continue links the identity into the verified primary and switches the login', async () => {
  /* validateToken 返回 { primary: 'google-oauth2|1' }：link 请求的 body 是 { provider: 'auth0', user_id: '2' }，
     setPrimaryUser 收到 'google-oauth2|1'，tenant claim 是 'personal' */ });
test('continue refuses a primary with a different or unverified email', async () => { /* 调用了 deny，没有发出 link 请求 */ });
```

每个测试都要把注释里写的结果写成 `assert`。

- [ ] **Step 2：运行测试，确认失败**

运行：`npm test -- --suite=37`
预期：FAIL，原因是找不到 `../deploy/auth0/post-login.cjs`。

- [ ] **Step 3：按上面的规则实现 `deploy/auth0/post-login.cjs`**

Management API 一律用全局 `fetch`，不引入 `auth0` npm 包。

- [ ] **Step 4：运行测试，确认通过**

运行：`npm test -- --suite=37`
预期：PASS。

- [ ] **Step 5：提交**

```bash
git add deploy/auth0/post-login.cjs tests/37-auth0-post-login.test.ts
git commit -m "Add the Auth0 Post-Login Action for verified email, tenant claims and account linking"
```

---

### Task 8：合并确认页 `/account/link`

**Files:**
- Modify: `apps/gateway/account-portal.ts`
- Modify: `tests/account-harness.ts`：`login` 支持 `start` 和 `startCookie`，见 Task 5 的接口。
- Test: `tests/37-account-portal.test.ts`

**Interfaces:**
- Consumes：
  - Task 5 的 `LoginAttempt.link`；
  - `auth0AccountLogin.start(…, { connection, linking: true })`；
  - Task 7 发来的 `session_token`。
- Produces：重定向到 `${OAUTH_ISSUER}continue?state=<原 state>&session_token=<HS256 JWT>`。JWT 的 claim 是 `{ sub, state, primary }`，用 `EIGOS_ACCOUNT_LINK_SECRET` 签名，5 分钟后过期。

**处理规则**：

- **GET `/account/link?session_token=&state=`**（同一地址每分钟最多 20 次）：
  - 用 jose 的 `jwtVerify` 验证 `session_token`：只接受 HS256，密钥是 `EIGOS_ACCOUNT_LINK_SECRET`，必须有 `sub`、`primary`、`connection` 三个字符串和 `exp`。`state` 长度要在 1 到 2000 之间。
  - 任何一项不通过，跳 `/account?status=link`。
  - 通过后，写入 cookie `__Host-eigos-account-link`：加密，purpose 为 `'link'`，5 分钟过期，内容是 `{ auth0State, subject: sub, primary, connection }`。然后显示页面：
    - h1：`合并账号`；
    - 说明：`这个邮箱已经有 EIGOS 账号。为了确认是你本人，请用原来的方式再登录一次，登录后两个登录方式会合并成一个账号。`；
    - 链接按钮：`用原来的方式登录`，指向 `/account/link/continue`。
- **GET `/account/link/continue`**：解开 link cookie，用 `link` 上下文发起登录。authorize 请求要带 `connection=<connection>`、`prompt=login`、`eigos_link=1`，不带 `screen_hint`。
- **callback 收到 `attempt.link` 时**：
  - 只有结果是 `verified` 且 `subject === link.primary`，才签发 continue token 并 303 跳转。
  - 其他情况跳 `/account?status=link`。
  - 合并模式下不开启 EIGOS 会话。
- 状态文案新增：`link: '合并没有完成，请用原来的方式重新登录。'`。

- [ ] **Step 1：写失败的测试**

```ts
test('the link page continues the Auth0 login only after the original account signs in', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'open' });
  const secret = new TextEncoder().encode('l'.repeat(32));
  const sessionToken = (key = secret) => new SignJWT({ primary: 'google-oauth2|old', connection: 'google-oauth2' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject('auth0|new').setExpirationTime('5m').sign(key);
  try {
    const bad = await fetch(g.url + '/account/link?state=orig&session_token=' + await sessionToken(new TextEncoder().encode('x'.repeat(32))), { redirect: 'manual' });
    assert.equal(bad.headers.get('location'), '/account?status=link');
    const page = await fetch(g.url + '/account/link?state=orig&session_token=' + await sessionToken(), { redirect: 'manual' });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /用原来的方式登录/);
    const linkCookie = page.headers.getSetCookie().find(c => c.startsWith('__Host-eigos-account-link='))!.split(';')[0]!;
    const start = await fetch(g.url + '/account/link/continue', { redirect: 'manual', headers: { Cookie: linkCookie } });
    const authorize = new URL(start.headers.get('location')!);
    assert.deepEqual([authorize.searchParams.get('connection'), authorize.searchParams.get('prompt'), authorize.searchParams.get('eigos_link')],
      ['google-oauth2', 'login', '1']);
    const wrong = await g.login('someone-else', 'amy@example.test', { start: '/account/link/continue', startCookie: linkCookie });
    assert.equal(wrong.location, '/account?status=link');
    const right = await g.login('google-oauth2|old', 'amy@example.test', { start: '/account/link/continue', startCookie: linkCookie });
    const resumed = new URL(right.location!);
    assert.equal(resumed.origin + resumed.pathname, 'https://identity.example/continue');
    assert.equal(resumed.searchParams.get('state'), 'orig');
    const { payload } = await jwtVerify(resumed.searchParams.get('session_token')!, secret, { algorithms: ['HS256'] });
    assert.deepEqual([payload.sub, payload.state, payload.primary], ['auth0|new', 'orig', 'google-oauth2|old']);
  } finally { await g.close(); await f.close(); }
});
```

- [ ] **Step 2：运行测试，确认失败**

运行：`npm test -- --suite=37`
预期：FAIL，`/account/link` 返回 404。

- [ ] **Step 3：按上面的规则实现两个路由和 callback 里的合并分支，再给 harness 的 `login` 加上 `start` 和 `startCookie`**

- [ ] **Step 4：运行测试，确认通过**

运行：`npm test -- --suite=37`
预期：PASS。

- [ ] **Step 5：提交**

```bash
git add apps/gateway/account-portal.ts tests/account-harness.ts tests/37-account-portal.test.ts
git commit -m "Confirm account linking by signing in with the original method"
```

---

### Task 9：重发验证信

**Files:**
- Create: `apps/gateway/auth0-management.ts`
- Modify: `apps/gateway/account-portal.ts`：`mountAccountPortal` 加第 5 个参数 `management?: Auth0Management`。
- Modify: `apps/gateway/app.ts`：provider 参数加 `management`；配置了 `OAUTH_MANAGEMENT_*` 时，默认用 `auth0Management(config)`。
- Modify: `tests/account-harness.ts`：`options.management` 传给 `createApp`。
- Test: `tests/37-account-portal.test.ts`

**Interfaces:**
- Produces：

```ts
export interface Auth0Management { resendVerification(subject: string): Promise<void> }
export function auth0Management(config: Config, fetcher?: typeof fetch): Auth0Management | undefined; // 没配置 OAUTH_MANAGEMENT_* 时返回 undefined
```

**处理规则**：

- **取 token**：`POST ${OAUTH_ISSUER}oauth/token`，JSON 是 `{ grant_type: 'client_credentials', client_id, client_secret, audience: ${OAUTH_ISSUER}api/v2/ }`，缓存到 `expires_in - 60` 秒。
- **重发**：`POST ${OAUTH_ISSUER}api/v2/jobs/verification-email`，JSON 是 `{ user_id: subject, client_id: OAUTH_MEMBER_CLIENT_ID }`。返回不是 2xx 就抛错。
- **未验证时的登录结果**：写入 cookie `__Host-eigos-account-verify`，加密，purpose 为 `'verify'`，10 分钟过期，内容是 `{ subject }`。
- **页面**：`status=verify` 且配置了 management 时，显示表单 POST `/account/resend-verification`，按钮 `重新发送验证邮件`。
- **POST `/account/resend-verification`**：
  - 在需要会话的那段检查之前处理；
  - 检查 Origin；
  - 同一地址每小时最多 5 次；
  - 解开 verify cookie，调用 `resendVerification`；
  - 成功跳 `/account?status=resent`，没有 cookie 或调用失败跳 `/account?status=verify`。
- 状态文案新增：`resent: '验证邮件已重新发送，请查收后重新登录。'`。

- [ ] **Step 1：写失败的测试**

```ts
test('an unverified user can ask Auth0 to resend the verification email', async () => {
  const sent: string[] = [];
  const f = await fixture(), g = await accountGateway(f, { signup: 'open', management: { async resendVerification(subject) { sent.push(subject); } } });
  try {
    const dan = await g.login('auth0|dan', 'dan@example.test', { verified: false });
    assert.equal(dan.location, '/account?status=verify');
    const verifyCookie = dan.response.headers.getSetCookie().find(c => c.startsWith('__Host-eigos-account-verify='))!.split(';')[0]!;
    assert.match(await (await fetch(g.url + '/account?status=verify', { headers: { Cookie: verifyCookie } })).text(), /重新发送验证邮件/);
    const post = (cookie: string, origin?: string) => fetch(g.url + '/account/resend-verification',
      { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, ...(origin ? { Origin: origin } : {}) } });
    assert.equal((await post(verifyCookie)).status, 403);
    assert.equal((await post('', g.config.PUBLIC_URL)).headers.get('location'), '/account?status=verify');
    assert.equal((await post(verifyCookie, g.config.PUBLIC_URL)).headers.get('location'), '/account?status=resent');
    assert.deepEqual(sent, ['auth0|dan']);
  } finally { await g.close(); await f.close(); }
});

test('the Auth0 management client caches its token and sends the job request', async () => { /* 用假的 fetcher：连续两次 resendVerification 只取一次 token；job 请求的 body 是 { user_id, client_id: 'portal' } */ });
```

- [ ] **Step 2：运行测试，确认失败**

运行：`npm test -- --suite=37`
预期：FAIL，原因是 harness 不接受 `management`，或者页面里没有这个按钮。

- [ ] **Step 3：按上面的规则实现 `auth0Management`，接入门户和 app，再给 harness 加上 `management`**

- [ ] **Step 4：运行测试，确认通过**

运行：`npm run check && npm test -- --suite=37`
预期：PASS。

- [ ] **Step 5：提交**

```bash
git add apps/gateway tests
git commit -m "Let unverified users ask Auth0 to resend the verification email"
```

---

### Task 10：运营指南与 README

**Files:**
- Rename: `docs/guides/member-mcp.md` → `docs/guides/accounts.md`（用 `git mv` 后重写）
- Modify: `README.md:65`（链接和文字改成「账号注册与 Grok MCP」）

**指南必须包含这些内容**：

1. **注册方式和三种开户模式。**
2. **Auth0：**
   - 门户回调改为 `https://<gateway>/account/callback`；
   - 部署 `deploy/auth0/post-login.cjs`，并列出 Task 7 的全部 secrets；
   - Management 应用（M2M）授予 `read:users` 和 `update:users`；
   - 部署前，先查出邮箱相同且都已验证的重复用户，逐个处理；
   - 保留现有的 Post-Login Actions，以及 tenant 字段的映射（`TENANT_METADATA_KEY`）；
   - Google（`google-oauth2`）和邮箱密码两个连接，都要对门户应用和 Grok 应用启用；
   - Grok 客户端的其他设置不变。
3. **Gateway 环境变量：**
   - `EIGOS_SIGNUP`、`EIGOS_ENFORCE_OWNER_RLS`；
   - `EIGOS_PORTAL_SECRET`；
   - `EIGOS_ACCOUNT_LINK_SECRET`，要和 Action 的 `LINK_SECRET` 相同；
   - `OAUTH_MANAGEMENT_CLIENT_ID` 和 `OAUTH_MANAGEMENT_CLIENT_SECRET`，可选；
   - `EIGOS_TRUST_PROXY`。
4. **PostgreSQL：**
   - 用管理角色执行 `npm run db:upgrade` 和 `npm run db:enable-owner-isolation`。
   - 运行角色的权限：
     - Gateway 需要 `accounts` 的 SELECT、INSERT(owner, email_hash)、UPDATE(approved_at, revoked_at, email_hash)；
     - `member_invitations` 和 `member_sessions` 的权限和以前一样；
     - Worker 需要 `accounts` 的 SELECT；
     - 停用和恢复账号，用管理角色执行运营者命令。
5. **运营者命令：**`npm run account -- show|suspend|restore …`、`npm run account:invite -- <email> 48`、`npm run access:grant-business -- <owner>`。发布或激活新版本时，`group:eigos-accounts` 会自动同步。
6. **验收：**和 Task 12 第 3 步相同。

- [ ] **Step 1：`git mv` 后写好指南，再更新 README**

- [ ] **Step 2：检查链接和空白字符**

运行：`grep -rn "member-mcp.md\|/members" README.md docs | grep -v superpowers; git diff --check`
预期：除了「旧地址会跳转」这句说明，`grep` 没有其他输出；`git diff --check` 没有输出。

- [ ] **Step 3：提交**

```bash
git add -A docs/guides README.md
git commit -m "Document self-service accounts, the Auth0 Action and operator commands"
```

---

### Task 11：全量检查、推送与 PR

**Files:** 无代码改动。

- [ ] **Step 1：在 scratchpad 里导出干净副本并安装依赖**

```bash
V=<scratchpad>/verify-step1; rm -rf $V && mkdir -p $V && git archive HEAD | tar -x -C $V && (cd $V && npm ci)
```

预期：`npm ci` 成功。

- [ ] **Step 2：启动自己的测试数据库**

```bash
NAME=eigos-review-claude-$(uuidgen | tr A-Z a-z)
docker run --detach --rm --name $NAME --publish 127.0.0.1::5432 --env POSTGRES_PASSWORD=synthetic-only postgres:17
export EIGOS_TEST_DATABASE_URL=postgres://postgres:synthetic-only@$(docker port $NAME 5432/tcp)/postgres
```

预期：容器在运行。记下 `$NAME`，之后只停这一个容器。

- [ ] **Step 3：在导出目录里跑全部检查**

运行：`cd $V && npm run check && npm run build && npm test && npm run test:e2e:run && git -C <worktree> diff --check origin/main...HEAD`
预期：全部通过，没有 FAIL。

- [ ] **Step 4：停掉自己的容器**

运行：`docker stop $NAME`

- [ ] **Step 5：推送分支并开 PR**

```bash
git push -u origin claude/ontology-mcp-runtime
```

PR 正文用 `pr` skill 写，内容包括：

- Palantir 依据，以及和 Palantir 不同的地方；
- 设计文档和计划的链接；
- 部署前要做的 Auth0 和数据库操作，标明要等用户授权。

运行：`gh pr create --base main --head claude/ontology-mcp-runtime --title "Self-service accounts and sign-up (step 1)" --body-file <正文文件>`
预期：拿到 PR 链接。

- [ ] **Step 6：等 CI 通过**

运行：`gh pr checks <PR号> --watch`
预期：`CI result` 通过。没通过就查原因并修复，然后重新推送。

---

### Task 12：部署与真实验收（需要用户授权）

**Files:** 无代码改动。证据记录在仓库外的私有位置。

- [ ] **Step 1：请用户授权**

用中文请用户授权。授权请求里列出下面这些对外操作：

- **Auth0：**
  - 新增回调 `/account/callback`；
  - 部署 Action 并配置 secrets；
  - 建立 M2M 应用；
  - 查出并处理同邮箱的重复用户。
- **生产环境变量。**
- **数据库：**`db:upgrade` 和 `db:enable-owner-isolation`。
- **部署 Gateway。**

得到授权之前不执行任何一项。

- [ ] **Step 2：按 `docs/guides/accounts.md` 执行已授权的操作**

预期：Gateway 的 `/health` 返回 ok，`/account` 能打开。

- [ ] **Step 3：真实验收**

只做查询和 synthetic 执行。依次验证：

1. 用新的 Google 账号注册，自动开通，状态是 active。
2. 用新邮箱加密码注册，验证邮箱之前看到 verify 提示；验证之后自动开通。
3. 用同一个邮箱换另一种方式登录，进入合并页；用原来的方式登录后合并完成，两种方式对应同一个 owner。
4. 授权 Grok，在 Grok 里查一次只读航班，结果在原对话里送达。
5. 撤销 Grok 授权后请求返回 403；重新授权后，新令牌可以用。
6. 停用账号后返回 403；恢复后可以用。

记录每一项的结果和标识。不记录令牌、邮箱、验证链接或凭据。

- [ ] **Step 4：把验收结果用中文回报给用户**
