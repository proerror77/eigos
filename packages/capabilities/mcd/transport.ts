import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { readFileSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { DomainError } from '../../core/domain.js';
import { digest } from '../../core/delegation.js';

const readTools = new Set(['query-nearby-stores', 'query-meals', 'query-meal-detail', 'calculate-price', 'query-order']);
export const mcdResponseSchema = z.object({ success: z.literal(true), code: z.literal(200), traceId: z.string().min(1), data: z.unknown() }).passthrough();
export type McdResponse = z.infer<typeof mcdResponseSchema>;
export interface McdSession { call(tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<McdResponse> }
export interface McdTransport { readonly evidenceKind: 'live_readonly' | 'fixture'; readonly configurationDigest: string; session<T>(work: (session: McdSession) => Promise<T>, signal: AbortSignal): Promise<T> }
export class OfficialMcdTransport implements McdTransport {
  readonly evidenceKind = 'live_readonly' as const; readonly configurationDigest: string;
  constructor(private tokenFile: string) { if (!isAbsolute(tokenFile)) throw new Error('MCD token file must be absolute'); this.configurationDigest = digest({ endpoint: 'https://mcp.mcd.cn', credentialRef: tokenFile, adapterVersion: '1' }); }
  async session<T>(work: (session: McdSession) => Promise<T>, signal: AbortSignal): Promise<T> {
    const stat = lstatSync(this.tokenFile);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new DomainError('FORBIDDEN', 'MCD credential file must be private and regular');
    const token = readFileSync(this.tokenFile, 'utf8').trim();
    if (!token || /\s/.test(token)) throw new DomainError('FORBIDDEN', 'MCD credential is unavailable');
    const client = new Client({ name: 'eigos-readonly-supply', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL('https://mcp.mcd.cn'), {
      requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' },
      fetch: (input, init) => fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(20000)]) }),
    });
    let calls = 0;
    try {
      await client.connect(transport);
      return await work({ call: async (tool, input, callSignal) => {
        if (!readTools.has(tool)) throw new DomainError('FORBIDDEN', 'MCD transport permits read-only tools only');
        callSignal.throwIfAborted(); if (++calls > 40) throw new DomainError('CONFLICT', 'MCD query budget exceeded');
        const response = await client.callTool({ name: tool, arguments: input }, { signal: callSignal, timeout: 20000 });
        if (response.isError) throw new Error('MCD rejected the read query');
        const values: unknown[] = response.structuredContent ? [response.structuredContent] : [];
        for (const content of response.content) if (content.type === 'text') { try { values.push(JSON.parse(content.text)); } catch { /* Display instructions are not business data. */ } }
        if (values.some(v => v && typeof v === 'object' && 'code' in v && v.code === 401)) throw new DomainError('FORBIDDEN', 'MCD read authorization is unavailable');
        const valid = values.map(v => mcdResponseSchema.safeParse(v)).filter(p => p.success);
        if (!valid.length) throw new Error('MCD did not return verified business success');
        return valid[0]!.data;
      } });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      signal.throwIfAborted(); throw new Error('MCD read query unavailable; raw transport diagnostics withheld');
    } finally { await client.close().catch(() => {}); }
  }
}
