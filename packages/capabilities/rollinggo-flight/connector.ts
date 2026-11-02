import { AgentReadError } from '../../core/agent-program.js';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

import { flightInputSchema, flightArguments, validateFlightDates, parseFlightResponse, type FlightInput } from './contracts.js';
const ENDPOINT = 'https://mcp.rollinggo.cn/mcp/flight';

/** Restricts all business calls to airport and flight searches. Credentials never enter tool input. */
export class RollingGoFlightConnector {
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
  async search(input: FlightInput, signal: AbortSignal) {
    const request = flightInputSchema.parse(input);
    validateFlightDates(request);
    const args = flightArguments(request), tool = request.kind === 'airports' ? 'searchAirports' : 'searchFlights';
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
            rpc.params?.name !== tool ||
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
      name: 'eigos-rollinggo-flight-readonly',
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
        { name: tool, arguments: args },
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
      const data = parseFlightResponse(request, content);
      await this.credential();
      bounded.throwIfAborted();
      return { data, observedAt: new Date().toISOString() };
    } catch {
      throw new AgentReadError(
        'RollingGo flight query unavailable or source schema rejected. Verify the private credential and provider endpoint; no booking, payment or ticket issuance was sent.',
      );
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }
}
