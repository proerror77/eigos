import { createServer, request } from 'node:http';
import { chmodSync } from 'node:fs';

const [, , socketPath, listener = '13213', origin = '3212', wait = '40000', limit = '128'] = process.argv;
const [port, originPort, waitMs, maxQueued] = [listener, origin, wait, limit].map(Number);
if (!socketPath?.startsWith('/') || [port, originPort, waitMs, maxQueued].some(value => !Number.isSafeInteger(value) || value < 1))
  throw new Error('Expected an absolute control socket path and positive integer options');

let holding = false;
let inflight = 0;
let forwarded = 0;
let expired = 0;
let overflow = 0;
const queued = new Map();
const hopByHop = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

function headersForNextHop(headers) {
  const excluded = new Set([...hopByHop, ...(headers.connection ?? '').toLowerCase().split(',').map(name => name.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name)));
}

function unavailable(response, reason) {
  response.writeHead(503, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain', Connection: 'close' });
  response.end(reason);
}

function forward(input, output) {
  inflight++;
  forwarded++;
  // Each request gets one upstream connection. An origin error never replays a request.
  const upstream = request({
    hostname: '127.0.0.1', port: originPort, method: input.method,
    path: input.url, headers: headersForNextHop(input.headers), agent: false,
  }, incoming => {
    output.writeHead(incoming.statusCode, headersForNextHop(incoming.headers));
    incoming.on('error', () => output.destroy());
    incoming.pipe(output);
  });
  input.on('error', () => upstream.destroy());
  upstream.on('error', () => {
    if (output.headersSent) output.destroy();
    else unavailable(output, 'Origin unavailable');
  });
  output.once('close', () => {
    if (!output.writableFinished) upstream.destroy();
    inflight--;
  });
  input.pipe(upstream);
}

const data = createServer((input, output) => {
  if (!holding) {
    forward(input, output);
    return;
  }
  if (queued.size >= maxQueued) {
    overflow++;
    unavailable(output, 'Release queue full');
    return;
  }

  // Leave the request stream unread until the origin can take it.
  const remove = () => {
    clearTimeout(timer);
    queued.delete(output);
  };
  const timer = setTimeout(() => {
    remove();
    expired++;
    unavailable(output, 'Release queue deadline elapsed');
  }, waitMs);
  output.once('close', remove);
  input.on('error', () => output.destroy());
  queued.set(output, () => {
    remove();
    output.off('close', remove);
    if (!output.destroyed) forward(input, output);
  });
});
data.listen(port, '127.0.0.1');

const control = createServer((input, output) => {
  if (input.method === 'POST' && input.url === '/hold' && !holding) holding = true;
  else if (input.method === 'POST' && input.url === '/serve' && holding) {
    holding = false;
    for (const dispatch of queued.values()) dispatch();
  } else if (input.method !== 'GET' || input.url !== '/status') {
    output.writeHead(409).end();
    return;
  }
  output.writeHead(200, { 'Content-Type': 'application/json' });
  output.end(JSON.stringify({ holding, inflight, forwarded, queued: queued.size, expired, overflow, waitMs }));
});
control.listen(socketPath, () => chmodSync(socketPath, 0o600));
