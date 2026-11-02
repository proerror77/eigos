import { constants } from 'node:fs';
import { open, readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentReadError } from '../../core/agent-program.js';
import { fliggyActions, fliggyInputSchema, fliggyArguments, parseFliggyResponse, validateFliggyInput, type FliggyInput } from './contracts.js';
import { FLIGGY_CLI_GUARD } from './cli-guard.js';

export const FLIGGY_CLI_VERSION = '1.0.16';
export const FLIGGY_CLI_SHA256 = '194a66eb84094f3d8ee20fac0a2d6cae10a405cd59ac100b7e7880ebc97297da';
export type FliggyCredential = { mode: 'trial'; keyFile?: never; keySha256?: never } | { mode: 'key'; keyFile: string; keySha256: string };
const run = promisify(execFile), require = createRequire(import.meta.url);
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** The vendor CLI owns signing. A pinned preload bounds its exact MCP read,
 * endpoint, account, response, cancellation and lifetime. No shell is invoked. */
export class FliggyConnector {
  constructor(private credential: FliggyCredential) {
    if (credential.mode === 'key' && (!isAbsolute(credential.keyFile) || !/^[a-f0-9]{64}$/.test(credential.keySha256))) throw new Error('Invalid private Fliggy credential binding');
  }
  private async key() {
    if (this.credential.mode === 'trial') return;
    const file = await open(this.credential.keyFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat(), value = (await file.readFile('utf8')).trim();
      if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 4096 || process.getuid && stat.uid !== process.getuid()
        || !/^[\x21-\x7E]{16,2048}$/.test(value) || hash(value) !== this.credential.keySha256) throw new Error('Fliggy credential changed');
      return value;
    } finally { await file.close(); }
  }
  async search(value: FliggyInput, signal: AbortSignal) {
    const input = fliggyInputSchema.parse(value);
    validateFliggyInput(input); signal.throwIfAborted();
    let directory: string | undefined;
    try {
      const key = await this.key();
      const cli = require.resolve('@fly-ai/flyai-cli/package.json').replace(/package\.json$/, 'dist/flyai-bundle.cjs');
      const metadata = JSON.parse(await readFile(require.resolve('@fly-ai/flyai-cli/package.json'),'utf8'));
      if (metadata.version !== FLIGGY_CLI_VERSION || hash(await readFile(cli)) !== FLIGGY_CLI_SHA256) throw new Error('Unreviewed FlyAI CLI version');
      directory = await mkdtemp(join(tmpdir(),'eigos-fliggy-'));
      const guard = join(directory,'guard.cjs'), policy = join(directory,'policy.json');
      await writeFile(guard, FLIGGY_CLI_GUARD, {mode:0o600});
      await writeFile(policy, JSON.stringify({ cli, cliSha256:FLIGGY_CLI_SHA256, tool:fliggyActions[input.kind].tool,
        args:fliggyArguments(input), ...(this.credential.mode === 'key' ? {keySha256:this.credential.keySha256} : {}) }), {mode:0o600});
      const args = ['--require',guard,cli,fliggyActions[input.kind].command];
      for (const [name,item] of Object.entries(input.criteria)) args.push('--'+name.replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),String(item));
      const { stdout } = await run(process.execPath,args,{
        env:{PATH:process.env.PATH??'',LANG:'C.UTF-8',FLYAI_JSON:'1',EIGOS_FLIGGY_POLICY_FILE:policy,...(key?{FLYAI_API_KEY:key}:{})},
        signal:AbortSignal.any([signal,AbortSignal.timeout(90000)]),timeout:90000,maxBuffer:1048576,windowsHide:true,
      });
      if (key && stdout.includes(key)) throw new Error('Credential echoed by source');
      const data = parseFliggyResponse(input,JSON.parse(stdout));
      if (this.credential.mode === 'trial' && data.resultState === 'results' && data.accessLevel !== 'trial') throw new Error('Trial account provenance is missing');
      await this.key();
      if (hash(await readFile(cli)) !== FLIGGY_CLI_SHA256) throw new Error('CLI changed during the read');
      signal.throwIfAborted();
      return { data, observedAt:new Date().toISOString() };
    } catch {
      throw new AgentReadError('Fliggy search failed or source/account validation was rejected. Preserve the task and check source availability or private Key configuration.');
    } finally { if (directory) await rm(directory,{recursive:true,force:true}); }
  }
}
