import { spawn, type ChildProcess } from 'node:child_process';
import { basename } from 'node:path';
import type { TestContext } from 'node:test';

/** Own children before awaiting startup, including children from a failed setup. */
export class FixtureProcesses {
  private children: ChildProcess[] = [];
  private stops = new Map<ChildProcess, Promise<void>>();
  private closing?: Promise<void>;

  constructor(private context: Pick<TestContext, 'after' | 'signal'>, cleanup: () => void | Promise<void> = () => {}, private shutdownGraceMs = 2000) {
    context.after(async () => {
      try { await this.close(); } finally { await cleanup(); }
    });
  }

  pids() { return this.children.flatMap(child => child.pid === undefined ? [] : [child.pid]); }

  async start(file: string, env: NodeJS.ProcessEnv = {}, readyTimeoutMs = 30000) {
    this.context.signal.throwIfAborted();
    if (this.closing) throw new Error('Fixture process scope is closed');
    const child = spawn(process.execPath, [file], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_NO_WARNINGS: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.children.push(child);
    let diagnostics = '';
    child.stderr.on('data', data => { diagnostics = (diagnostics + data.toString()).slice(-12000); });
    try {
      const ready = await new Promise<{ port?: number; pid?: number }>((resolve, reject) => {
        let output = '';
        const error = (message: string) => new Error(`${basename(file)} ${message}: ${diagnostics}`);
        const finish = (failure?: Error, value?: { port?: number; pid?: number }) => {
          clearTimeout(timer); child.stdout.off('data', onData); child.stdout.resume();
          child.off('error', onError); child.off('exit', onExit); this.context.signal.removeEventListener('abort', onAbort);
          if (failure) reject(failure); else resolve(value!);
        };
        const onError = (failure: Error) => finish(error(`could not start (${failure.message})`));
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(error(`exited before readiness (${code ?? signal})`));
        const onAbort = () => finish(error('startup was aborted'));
        const onData = (data: Buffer) => {
          output += data.toString(); const lines = output.split('\n'); output = lines.pop()!.slice(-12000);
          for (const line of lines) {
            try {
              const value = JSON.parse(line);
              if (value && typeof value === 'object' && (value.ready === true || typeof value.port === 'number' && value.port > 0)) { finish(undefined, value); return; }
            } catch { /* Non-protocol diagnostics do not indicate readiness. */ }
          }
        };
        const timer = setTimeout(() => finish(error(`did not become ready within ${readyTimeoutMs}ms`)), readyTimeoutMs);
        child.stdout.on('data', onData); child.once('error', onError); child.once('exit', onExit);
        this.context.signal.addEventListener('abort', onAbort, { once: true });
      });
      return { process: child, ready, error: () => diagnostics };
    } catch (error) {
      await this.stop(child);
      throw error;
    }
  }

  stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const previous = this.stops.get(child);
    if (previous) return previous;
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return Promise.resolve();
    const stopped = new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(force); clearTimeout(deadline); child.off('exit', onExit); child.off('error', onError);
        if (error) reject(error); else resolve();
      };
      const onExit = () => finish(), onError = (error: Error) => finish(error);
      const force = setTimeout(() => child.kill('SIGKILL'), this.shutdownGraceMs);
      const deadline = setTimeout(() => finish(new Error(`Fixture child ${child.pid} did not exit after SIGKILL`)), this.shutdownGraceMs + 2000);
      child.once('exit', onExit); child.once('error', onError); child.kill(signal);
    });
    this.stops.set(child, stopped);
    return stopped;
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      const results = await Promise.allSettled([...this.children].reverse().map(child => this.stop(child)));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Fixture process cleanup failed');
    })();
  }
}
