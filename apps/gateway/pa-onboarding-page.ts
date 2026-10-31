import type { Config } from '../../packages/core/config.js';
import { paBootstrapPrompt, paConnectionInfo } from '../../packages/members/pa-onboarding.js';

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export const onboardingScript = `document.querySelectorAll('[data-copy]').forEach(button => {
  button.addEventListener('click', async () => {
    const field = document.getElementById(button.dataset.copy);
    const status = document.getElementById('copy-status');
    try { await navigator.clipboard.writeText(field.value); button.textContent = '已复制'; status.textContent = '已复制，可以交给你的 PA。'; }
    catch { field.focus(); field.select(); button.textContent = '请手动复制'; status.textContent = '请复制已选中的文字。'; }
  });
});`;

export function paOnboardingPage(c: Config): string {
  const connection = paConnectionInfo(c), beta = c.EIGOS_INVITE_BETA === 'true';
  const instructions = paBootstrapPrompt(c);
  const selfCheck = '请检查刚连接的 EIGOS：确认你已发现并启用 eigos-delegate Skill，读取当前实例和可发现的服务，说明哪些能力已有访问权限、哪些还需要我授权。这次只检查连接，不创建任务。';
  const membership = c.EIGOS_MEMBERSHIP_APPROVAL === 'invite-only'
    ? '登录会员中心并同意开通资料，再兑换绑定本人身份的邀请。'
    : c.EIGOS_MEMBERSHIP_APPROVAL === 'manual'
      ? '登录会员中心并提交开通申请，等待审核结果。'
      : '登录会员中心并同意开通自己的会员资料。';
  const native = connection.transports.mcp;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>连接你的 PA · EIGOS</title><style>
:root{color-scheme:light;--ink:#151515;--paper:#fafaf8;--muted:#62625f;--line:#d8d8d2;--panel:#fff}*{box-sizing:border-box}body{margin:0;color:var(--ink);background:var(--paper);font:16px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}a{color:inherit;text-underline-offset:4px}header,main,footer{width:min(1080px,100%);margin:auto;padding:24px 32px}header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);gap:20px}.wordmark{font-weight:800;letter-spacing:.13em;font-size:24px;text-decoration:none}nav{display:flex;gap:24px;font-size:14px}.hero{padding:56px 0 36px;max-width:780px}.eyebrow{font-size:12px;letter-spacing:.15em;color:var(--muted);text-transform:uppercase}h1{font:500 clamp(36px,6vw,64px)/1.15 "Iowan Old Style","Songti SC",Georgia,serif;letter-spacing:-.035em;margin:14px 0 24px}h2{font-size:23px;line-height:1.4;margin:0 0 12px}h3{font-size:17px;margin:0 0 8px}.lead{font-size:19px;max-width:37em}.muted,small{color:var(--muted)}.notice{border-left:3px solid var(--ink);padding:12px 20px;background:#eeeeda;font-size:14px}.steps{counter-reset:step}.step{display:grid;grid-template-columns:48px 1fr;gap:20px;padding:32px 0;border-top:1px solid var(--line)}.step::before{counter-increment:step;content:counter(step,decimal-leading-zero);font-size:14px;color:var(--muted);padding-top:5px}.step-body{min-width:0}p{margin:10px 0 18px}.actions{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:18px 0}.button,button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;border:1px solid var(--ink);border-radius:4px;padding:10px 18px;background:var(--panel);color:var(--ink);font:inherit;font-size:14px;text-decoration:none;cursor:pointer}.primary{background:var(--ink);color:white}button:hover,.button:hover{opacity:.8}textarea,pre{width:100%;border:1px solid var(--line);border-radius:4px;background:var(--panel);padding:16px;font:13px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}textarea{display:block;resize:vertical;min-height:100px}label{display:block;font-size:14px;margin:16px 0 8px}code{font-size:13px;overflow-wrap:anywhere}details{border:1px solid var(--line);border-radius:4px;padding:16px 20px;margin:12px 0;background:var(--panel)}summary{font-weight:600;cursor:pointer;min-height:26px}details p{font-size:14px}.examples{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:24px 0}.examples article{border:1px solid var(--line);padding:20px;background:var(--panel)}.examples p{font-size:14px;margin-bottom:0}.status{font-size:14px;min-height:24px}footer{border-top:1px solid var(--line);font-size:12px;color:var(--muted);display:flex;justify-content:space-between;gap:16px}:focus-visible{outline:3px solid #175cd3;outline-offset:3px}@media(max-width:680px){header,main,footer{padding:20px}.hero{padding-top:36px}.step{grid-template-columns:30px 1fr;gap:12px}.examples{grid-template-columns:1fr}nav{gap:14px}.lead{font-size:17px}h1{font-size:42px}footer{flex-direction:column}}
</style><script src="/connect/onboarding.js" defer></script></head><body>
<header><a class="wordmark" href="/">EIGOS</a><nav aria-label="主导航"><a href="#connect">连接我的 PA</a><a href="/members">会员中心</a></nav></header>
<main><section class="hero"><p class="eyebrow">EIGOS · ${beta ? '邀请内测' : 'Personal Agent connection'}</p>
<h1>让你的 PA 知道，<br>什么时候找 EIGOS。</h1><p class="lead">连接自己的个人助手。需要查询或安排服务时，让它检查 EIGOS 当前可用能力，处理必要授权，并把同一个任务的实际结果带回来。</p>
${beta ? '<p class="notice">本轮邀请内测提供基于已有材料的文档、分析、计划和任务说明。实际服务范围以连接后的发现结果为准，尚不开放真实预订、采购、付款或对外发送。</p>' : '<p class="muted">出行、住宿、旅行与预约是检查服务的场景。是否有相应服务、能否查询或办理，由当前部署及你的权限决定。</p>'}
</section><div class="steps">
<section class="step"><div class="step-body"><h2>先开通你自己的账号</h2><p>${membership} PA 的登录和服务权限会分别检查。</p><a class="button" href="/members">登录 / 注册</a></div></section>
<section class="step" id="connect"><div class="step-body"><h2>连接 PA，并启用 EIGOS Skill</h2><p>把下面的接入指令交给你的 PA，让它按支持的方式完成配置。MCP 或 A2A 接通一种即可；Skill 告诉它何时使用 EIGOS。</p>
<label for="connection-prompt">交给 PA 的接入指令</label><textarea id="connection-prompt" readonly rows="7">${escape(instructions)}</textarea>
<div class="actions"><button type="button" class="primary" data-copy="connection-prompt">复制接入指令</button><a class="button" href="/connect/eigos-delegate.tar.gz" download>下载完整 Skill</a><a href="/connect/SKILL.md">查看 Skill</a></div>
<p class="muted">下载后解压，将 <code>eigos-delegate</code> 文件夹放入 PA 支持的 Skill 目录，或使用宿主支持的导入方式。刷新或重启后，确认它已出现在 PA 的可用 Skill 中。接入包包含使用指引和公开连接信息，不含个人凭据。</p>
${native ? `<details><summary>Codex · 原生 MCP</summary><p>将下面的连接配置加入 Codex 的 <code>~/.codex/config.toml</code>。已有同名连接时更新该连接，保留其他配置。</p><label for="codex-config">公开连接配置</label><textarea id="codex-config" readonly rows="8">${escape(native.codexConfig)}</textarea><div class="actions"><button type="button" data-copy="codex-config">复制配置</button></div><p>运行 <code>codex mcp login eigos</code>，在显示的页面完成本人授权。连接配置与 Skill 都需要在宿主中生效。</p></details>
<details><summary>Grok Bot · 支持原生 MCP 的宿主</summary><p>在宿主的 MCP 连接设置中使用地址 <code>${escape(native.url)}</code>，公开客户端 ID 为 <code>${escape(native.clientId)}</code>。请求范围为 <code>${escape(native.scopes.join(' '))}</code>，随后完成本人登录。实际兼容性以该宿主的连接检查为准。</p><p>用宿主支持的方式导入完整 Skill；仅保存网址不会自动启用使用规则。</p></details>` : '<p class="muted">本实例未配置原生 MCP 的公开登录客户端。请使用下方已配置的 A2A 方式。</p>'}
${connection.transports.a2a ? `<details><summary>A2A · 支持 Agent 连接的 PA</summary><p>让 PA 从 <a href="${escape(connection.transports.a2a.agentCard)}">Agent Card</a> 和 <a href="${escape(connection.transports.a2a.registration)}">接入发现信息</a> 开始，完成独立登记及本人设备授权。保持同一个安装登记，按返回的下一步和等待间隔继续。</p><p>需要 PA 本身支持 A2A 客户端和安全凭据管理；本页面不会替不支持的宿主安装执行能力。</p></details>` : ''}
</div></section>
<section class="step"><div class="step-body"><h2>完成授权，再让 PA 检查连接</h2><p>按 PA 返回的页面完成本人登录、会员准入和必要权限。已有授权继续沿用；数据或服务范围不足时，只补充所需部分。</p>
${connection.links.permissions ? '<p><a href="/members/permissions">查看并管理我的授权范围</a></p>' : ''}
<label for="check-prompt">连接后交给 PA 的检查指令</label><textarea id="check-prompt" readonly rows="4">${escape(selfCheck)}</textarea><div class="actions"><button type="button" data-copy="check-prompt">复制检查指令</button></div><p class="muted">网站可打开、Skill 已下载、OAuth 已登录，分别是不同检查。以 PA 实际读到的身份、权限和服务为准；连接检查不产生业务订单。</p></div></section>
<section class="step"><div class="step-body"><h2>直接说你想完成什么</h2><p>不必每次提到 EIGOS。PA 会根据任务意图检查服务，再决定如何处理。</p><div class="examples">
<article><h3>查询出行</h3><p>“明天从家去机场，先帮我查车价，只查询。”</p></article><article><h3>安排旅行</h3><p>“下周去北京开会，看看住宿和交通有哪些可用服务。”</p></article><article><h3>委托文档</h3><p>“请通过 EIGOS，按我给的会议材料整理一份议程。”</p></article></div>
<p>缺少资料时，PA 会在原任务中补充；需要权限时，带你完成对应授权。查询、预订、写日历和付款分别检查许可。服务不支持或只完成一部分时，会说明实际情况。</p><p class="muted">真实下单与付款仍未由本接入流程启用。纯知识问答和创意写作由 PA 照常处理。</p></div></section>
</div><p id="copy-status" class="status" role="status" aria-live="polite"></p>
<details><summary>公开连接信息</summary><p>实例 <code>${escape(c.PUBLIC_URL)}</code></p><p><a href="/connect/agent.json">供 PA 读取的接入信息</a> · <a href="/.well-known/agent-card.json">Agent Card</a></p><p>公开配置不包含访问令牌。个人凭据由 PA 宿主管理，服务账号凭据使用对应的私有连接流程。</p></details>
</main><footer><span>EIGOS · Consider It Done.</span><a href="/members">管理账号与连接</a></footer></body></html>`;
}
