/** A fixed child-process preload. All variable policy is JSON data in a private
 * file; model and provider content never become executable source. */
export const FLIGGY_CLI_GUARD = String.raw`
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const policy = JSON.parse(fs.readFileSync(process.env.EIGOS_FLIGGY_POLICY_FILE, 'utf8'));
const originalRead = fs.readFileSync, originalExists = fs.existsSync;
const config = path.join(os.homedir(), '.flyai', 'config.json');
// Never fall back to the caller's unrelated global FlyAI account. The explicit
// key environment wins in key mode; trial mode uses the vendor's built-in trial.
fs.existsSync = function(file) { return String(file) === config ? false : originalExists.apply(this, arguments); };
fs.readFileSync = function(file) {
  if (String(file) === config) throw new Error('Implicit FlyAI account configuration is forbidden');
  return originalRead.apply(this, arguments);
};
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
if (hash(originalRead(policy.cli)) !== policy.cliSha256) throw new Error('CLI integrity changed');
const equal = (a,b) => {
  const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k,canonical(x[k])])) : x;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
};
const request = globalThis.fetch;
let calls = 0;
globalThis.fetch = async function(target, init = {}) {
  if (String(target) !== 'https://flyai.open.fliggy.com/mcp' || init.method !== 'POST' || ++calls !== 1) throw new Error('Only one exact FlyAI read is allowed');
  const body = JSON.parse(String(init.body));
  if (body.method !== 'tools/call' || body.params?.name !== policy.tool || !equal(body.params.arguments, policy.args)) throw new Error('FlyAI tool or criteria changed');
  if (policy.keySha256) {
    const auth = new Headers(init.headers).get('authorization')?.replace(/^Bearer /,'');
    if (!auth || hash(auth) !== policy.keySha256) throw new Error('FlyAI account changed');
  }
  const response = await request(target, {...init, redirect:'manual', signal:AbortSignal.any([init.signal,AbortSignal.timeout(80000)].filter(Boolean))});
  if (response.redirected || response.status >= 300 && response.status < 400) throw new Error('FlyAI redirect blocked');
  if (!response.body) return response;
  let bytes=0;
  return new Response(response.body.pipeThrough(new TransformStream({transform(chunk,controller){
    bytes += chunk.byteLength;
    if (bytes > 1048576) throw new Error('FlyAI response exceeds its bound');
    controller.enqueue(chunk);
  }})),{status:response.status,statusText:response.statusText,headers:response.headers});
};
`;
