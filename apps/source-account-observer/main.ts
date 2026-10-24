import https from 'node:https';
import { writeFileSync } from 'node:fs';
import { gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib';
import { TLSSocket } from 'node:tls';
import { paotuiAccountResponse } from '../../packages/capabilities/paotui-account-response.js';

// A private preload of the official CLI. It observes that command's existing
// HTTPS response; it never sends a request, changes headers or exposes a tool.
const output = process.env.EIGOS_SOURCE_ACCOUNT_RESULT;
const credential = process.env.MCP_ACCESS_TOKEN;
if (output && credential) {
  const request = https.request;
  https.request = function (...args: Parameters<typeof https.request>) {
    const req = Reflect.apply(request, https, args);
    req.prependListener('response', res => {
      if (req.protocol !== 'https:' || req.getHeader('host') !== 'mcp-open-cater.meituan.com'
        || req.path !== '/v1/api/paotui/get_address_list' || req.method !== 'POST'
        || req.getHeader('mtcp-ak') !== credential || res.statusCode !== 200
        || !(res.socket instanceof TLSSocket) || !res.socket.authorized) return;
      const encoding = res.headers['content-encoding'];
      let size = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= 512000) chunks.push(chunk); });
      res.on('end', () => {
        try {
          if (size > 512000) return;
          let buffer = Buffer.concat(chunks);
          const options = { maxOutputLength: 512000 };
          if (encoding === 'gzip') buffer = gunzipSync(buffer, options);
          else if (encoding === 'br') buffer = brotliDecompressSync(buffer, options);
          else if (encoding === 'deflate') buffer = inflateSync(buffer, options);
          else if (encoding && encoding !== 'identity') return;
          const proof = paotuiAccountResponse(JSON.parse(buffer.toString('utf8')));
          if (proof) writeFileSync(output, JSON.stringify(proof), { mode: 0o600, flag: 'wx' });
        } catch { /* Missing or ambiguous identity fails closed without leaking payloads. */ }
      });
    });
    return req;
  } as typeof https.request;
}
