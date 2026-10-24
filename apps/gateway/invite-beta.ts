import type { Express } from 'express';
import type { Config } from '../../packages/core/config.js';
import { TASK_SCOPES, type Principal } from '../../packages/core/domain.js';
import { inviteBetaCodexConfig } from '../../packages/members/native-mcp.js';

/** The public beta exposes task access even if an issuer accidentally returns
 * additional scopes. Membership and per-user client revocation still apply. */
export function inviteBetaPrincipal(config: Config, principal: Principal): Principal | undefined {
  if (config.EIGOS_INVITE_BETA !== 'true') return principal;
  if (![config.OIDC_MCP_CLIENT_ID, config.OIDC_AGENT_CLIENT_ID].includes(principal.clientId)) return undefined;
  return { ...principal, scopes: principal.scopes.filter(scope => (TASK_SCOPES as readonly string[]).includes(scope)) };
}

const html = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export function mountInviteBeta(app: Express, config: Config): void {
  if (config.EIGOS_INVITE_BETA !== 'true') return;
  const clientConfig = inviteBetaCodexConfig(config.PUBLIC_URL, config.OIDC_MCP_CLIENT_ID!);
  app.get('/', (_req, res) => {
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EIGOS · 邀请内测</title>
<style>body{font:16px/1.7 system-ui,sans-serif;max-width:760px;margin:60px auto;padding:0 24px;color:#171717;background:#fafafa}h1{font-size:36px;line-height:1.2}h2{margin-top:32px;font-size:22px}a{color:inherit}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:18px;background:#eee;border:1px solid #ddd;border-radius:8px}small{color:#555}li{margin:10px 0}.button{display:inline-block;padding:10px 18px;background:#171717;color:white;border-radius:6px;text-decoration:none}</style>
<main><small>EIGOS · 艾戈斯 · 邀请内测</small><h1>让你的 Agent 委托一个任务</h1>
<p>本轮提供基于你所给资料的文档草稿、会议议程、分析与计划，以及任务说明整理。任务说明不代表其中的业务已经执行。</p>
<p>本入口不接收供应商账号凭据，不执行预订、采购、付款或对外发送。服务由内测主机运行，主机离线或休眠时可能暂时不可用。</p>
<h2>接入步骤</h2><ol><li><a href="/members">登录会员中心</a>，填写自己的资料并同意开通。取得绑定本人身份的邀请后，在会员中心兑换。</li>
<li>将以下公开连接配置加入 Codex 的 <code>~/.codex/config.toml</code>；若已有同名连接，请更新该连接：<pre>${html(clientConfig)}</pre>然后运行 <code>codex mcp login eigos</code>，按显示的页面完成本人授权。需要重新授权时运行同一命令。</li>
<li>向自己的 Agent 提出文档任务，例如：<pre>请通过 EIGOS，按下面的材料生成一份中文会议议程……</pre>Agent 会提交需求、在同一个任务中补充必要信息，并读取最终交付物。</li></ol>
<p><a class="button" href="/members">进入会员中心</a></p><h2>连接信息</h2><pre>MCP：${html(config.PUBLIC_URL)}/mcp\nA2A：${html(config.PUBLIC_URL)}/a2a\nOAuth 客户端 ID：${html(config.OIDC_MCP_CLIENT_ID!)}</pre>
<p>OAuth 客户端 ID 可以公开；登录令牌和邀请凭据属于你本人。你可以在会员中心停用本人的客户端连接。Grok Bot 可使用相同 MCP 地址，在原生连接中填写上述公开 client ID，并请求 openid、offline_access、services:read、tasks:read、tasks:write 后完成本人登录。A2A 使用同一实例的独立 Agent 登记和本人授权。是否接通以当前任务的实际调用和回读为准。</p></main></html>`);
  });
}
