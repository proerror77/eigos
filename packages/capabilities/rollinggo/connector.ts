import { AgentReadError } from '../../core/agent-program.js';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { z } from 'zod';

const ENDPOINT = 'https://mcp.rollinggo.ai/mcp';
export const rollingGoInputSchema = z.strictObject({
  originQuery: z.string().min(1).max(500),
  place: z.string().min(1).max(200),
  placeType: z.enum([
    'city',
    'airport',
    'point_of_interest',
    'train_station',
    'subway_station',
    'hotel',
    'district/county',
    'detailed address',
  ]),
  checkInParam: z.strictObject({
    checkInDate: z.iso.date(),
    stayNights: z.number().int().min(1).max(28),
    adultCount: z.number().int().min(1).max(20),
  }),
  localeParam: z.strictObject({
    currency: z.string().regex(/^[A-Z]{3}$/),
    language: z.enum(['en', 'zh', 'ja']),
  }),
  size: z.number().int().min(1).max(10),
});
export type RollingGoSearchInput = z.infer<typeof rollingGoInputSchema>;
export const rollingGoResultSchema = z.object({
  success: z.boolean(),
  hotelInformationList: z
    .array(
      z.object({
        hotelId: z.number().int(),
        name: z.string().nullable().optional(),
        nameEn: z.string().nullable().optional(),
        address: z.string().nullable().optional(),
        price: z
          .object({
            hasPrice: z.boolean(),
            currency: z.string().optional(),
            lowestPrice: z.number().finite().nonnegative().optional(),
          })
          .optional(),
      }),
    )
    .max(10),
});

/** Restricts all business calls to hotel search. Credentials never enter tool input. */
export class RollingGoSearchConnector {
  constructor(
    private readonly keyFile: string,
    private readonly keySha256: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!isAbsolute(keyFile) || !/^[a-f0-9]{64}$/.test(keySha256))
      throw new Error('INVALID_ROLLINGGO_BINDING');
  }
  private async credential() {
    const file = await open(
      this.keyFile,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > 2048 ||
        stat.mode & 0o077 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new Error('INVALID_KEY_FILE');
      const key = (await file.readFile('utf8')).trim();
      if (
        !/^mcp_[A-Za-z0-9_-]{8,1024}$/.test(key) ||
        createHash('sha256').update(key).digest('hex') !== this.keySha256
      )
        throw new Error('INVALID_KEY');
      return key;
    } finally {
      await file.close();
    }
  }
  async search(input: RollingGoSearchInput, signal: AbortSignal) {
    const args = rollingGoInputSchema.parse(input);
    const today = new Date().toISOString().slice(0, 10);
    if (args.checkInParam.checkInDate < today) throw new Error('PAST_CHECK_IN');
    const key = await this.credential();
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
    let calls = 0,
      businessCalls = 0;
    const guarded: typeof fetch = async (target, init = {}) => {
      if (String(target) !== ENDPOINT || ++calls > 20)
        throw new Error('UNEXPECTED_ENDPOINT');
      if (init.method === 'POST') {
        const rpc = JSON.parse(String(init.body));
        if (
          ![
            'initialize',
            'notifications/initialized',
            'notifications/cancelled',
            'tools/list',
            'tools/call',
            'ping',
          ].includes(rpc.method)
        )
          throw new Error('RPC_NOT_ALLOWED');
        if (
          rpc.method === 'tools/call' &&
          (++businessCalls > 1 ||
            rpc.params?.name !== 'searchHotels' ||
            JSON.stringify(rpc.params.arguments) !== JSON.stringify(args))
        )
          throw new Error('TOOL_NOT_ALLOWED');
      } else if (!['GET', 'DELETE'].includes(init.method ?? 'GET'))
        throw new Error('METHOD_NOT_ALLOWED');
      const response = await this.fetcher(target, {
        ...init,
        redirect: 'manual',
        signal: bounded,
      });
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400)
      )
        throw new Error('REDIRECT_BLOCKED');
      if (!response.body) return response;
      let bytes = 0;
      const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            bytes += chunk.byteLength;
            if (bytes > 1048576) throw new Error('RESPONSE_TOO_LARGE');
            controller.enqueue(chunk);
          },
        }),
      );
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
    const client = new Client({
      name: 'eigos-rollinggo-readonly',
      version: '1',
    });
    const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
      fetch: guarded,
      requestInit: {
        headers: { Authorization: `Bearer ${key}` },
        redirect: 'manual',
      },
      reconnectionOptions: {
        maxRetries: 0,
        maxReconnectionDelay: 1000,
        initialReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
    });
    try {
      await client.connect(transport, { signal: bounded, timeout: 15000 });
      const result = await client.callTool(
        { name: 'searchHotels', arguments: args },
        { signal: bounded, timeout: 45000 },
      );
      if (result.isError || JSON.stringify(result).includes(key))
        throw new Error('SOURCE_REJECTED');
      const content =
        result.structuredContent ??
        (() => {
          const part = result.content.find((x) => x.type === 'text');
          if (!part || part.type !== 'text') throw new Error('INVALID_SOURCE');
          return JSON.parse(part.text);
        })();
      const parsed = rollingGoResultSchema.parse(content);
      if (
        !parsed.success ||
        parsed.hotelInformationList.length > args.size ||
        new Set(parsed.hotelInformationList.map((h) => h.hotelId)).size !==
          parsed.hotelInformationList.length
      )
        throw new Error('SOURCE_REJECTED');
      await this.credential();
      return {
        hotels: parsed.hotelInformationList ?? [],
        observedAt: new Date().toISOString(),
        priceKind: 'reference' as const,
        providerExpiry: 'unknown' as const,
      };
    } catch {
      throw new AgentReadError(
        'RollingGo search failed; verify the private credential and provider availability. No order or payment was sent.',
      );
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }
}
