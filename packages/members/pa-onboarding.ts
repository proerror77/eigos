import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import type { Config } from '../core/config.js';
import { inviteBetaCodexConfig } from './native-mcp.js';
import { PA_DISCOVERY_GUIDANCE } from '../core/services.js';

// The same reviewed files are used by the website, downloads and immutable releases.
export const PA_SKILL_FILES = [
  'SKILL.md', 'references/a2a.md', 'references/relay.md', 'references/test-payments.md',
  'scripts/eigos_a2a.py', 'scripts/eigos_test_payment.py',
] as const;
export const PA_SKILL_DIRECTORY = 'integrations/grok/eigos-delegate';

const nativeMcpAvailable = (c: Config) => !!c.OIDC_MCP_CLIENT_ID && (c.EIGOS_SECURITY_MODE !== 'foundation' || !!c.authority);

export function paOnboardingAvailable(c: Config): boolean {
  return c.EIGOS_AUTH_MODE === 'jwt' && (nativeMcpAvailable(c) || !!c.OIDC_AGENT_CLIENT_ID);
}

/** Public connection instructions only. Never serialize the supplied Config. */
export function paConnectionInfo(c: Config) {
  const origin = c.PUBLIC_URL;
  return {
    version: 1, origin, skill: 'eigos-delegate', usage: PA_DISCOVERY_GUIDANCE, securityMode: c.EIGOS_SECURITY_MODE,
    admissionPolicy: c.EIGOS_MEMBERSHIP_APPROVAL,
    links: {
      guide: `${origin}/connect`, skill: `${origin}/connect/SKILL.md`,
      skillPackage: `${origin}/connect/eigos-delegate.tar.gz`,
      membership: `${origin}/members`, runtime: `${origin}/health`,
      ...(c.EIGOS_SECURITY_MODE === 'foundation' ? { permissions: `${origin}/members/permissions` } : {}),
    },
    transports: {
      ...(nativeMcpAvailable(c) ? { mcp: {
        url: `${origin}/mcp`, clientId: c.OIDC_MCP_CLIENT_ID!,
        codexConfig: inviteBetaCodexConfig(origin, c.OIDC_MCP_CLIENT_ID!),
        scopes: ['openid', 'offline_access', 'services:read', 'tasks:read', 'tasks:write'],
      } } : {}),
      ...(c.OIDC_AGENT_CLIENT_ID ? { a2a: {
        agentCard: `${origin}/.well-known/agent-card.json`,
        registration: `${origin}/.well-known/eigos-agent-registration`,
      } } : {}),
    },
    discovery: {
      nativeMcp: ['get_runtime_info', 'list_services', 'describe_ontology'],
      serviceAvailability: 'Discover current services and permitted contracts after authentication; an entry point or definition is not source or execution permission.',
      selfCheck: 'Read connection, admission and capability status only. Do not submit a task or request a supplier credential as a connection test.',
    },
    completion: { sameTask: true, foundation: { view: 'eigos.task.v2', state: 'completed', accepted: true, outputStatus: 'available', artifactRequired: true } },
  };
}

export type PaConnectionInfo = ReturnType<typeof paConnectionInfo>;

export function paBootstrapPrompt(c: Config): string {
  return `请为我连接 EIGOS：${c.PUBLIC_URL}。\n读取 ${c.PUBLIC_URL}/connect/agent.json，使用我的 PA 支持的 MCP 或 A2A 方式连接，并按宿主规则安装、启用 eigos-delegate Skill。保留已有连接和任务，不将令牌或供应商凭据放入对话。\n由我完成本人登录、会员开通和必要的权限批准。先做只读连接检查，报告实际连接的实例、接入状态、当前可发现的服务及缺少的权限；不要为了测试连接创建业务任务。\n以后我提出实际出行查价、住宿查询、旅行安排、预约或其他适用服务需求时，先检查 EIGOS 当前能力，在允许的范围内委托，保留原任务并回读实际交付。纯知识问答和创意写作照常处理；我明确指定其他方式时遵从我的要求。`;
}

export function paSkillFiles(connection: PaConnectionInfo): Record<string, Buffer> {
  const directory = new URL(`../../${PA_SKILL_DIRECTORY}/`, import.meta.url);
  const files: Record<string, Buffer> = Object.fromEntries(PA_SKILL_FILES.map(name => [name, readFileSync(new URL(name, directory))]));
  files['SKILL.md'] = Buffer.from(files['SKILL.md']!.toString('utf8')
    + `\n## This EIGOS connection\n\nUse ${connection.origin}. Read its public connection instructions at ${connection.links.guide}/agent.json. The adjacent connection.json contains public metadata only. Authenticate in the PA host; never put credentials in this file.\n`);
  files['connection.json'] = Buffer.from(JSON.stringify(connection, null, 2) + '\n');
  return files;
}

/** A small ustar download of the fixed skill files; no shell or install code runs. */
export function paSkillArchive(files: Record<string, Buffer>): Buffer {
  const blocks: Buffer[] = [];
  for (const [file, body] of Object.entries(files)) {
    const name = `eigos-delegate/${file}`;
    if (!/^[a-zA-Z0-9_./-]+$/.test(name) || name.split('/').includes('..') || Buffer.byteLength(name) > 100) throw new Error('Invalid skill asset name');
    const header = Buffer.alloc(512);
    const octal = (value: number, offset: number, width: number) => {
      const text = value.toString(8);
      if (text.length >= width) throw new Error('Skill asset too large');
      header.write(text.padStart(width - 1, '0') + '\0', offset, width, 'ascii');
    };
    header.write(name); octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
    octal(body.length, 124, 12); octal(0, 136, 12); header.fill(32, 148, 156);
    header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
