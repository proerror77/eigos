import type { Database } from '../database.js';
import type { PublishedOntology } from '../metadata.js';
import { KernelClient } from './client.js';

/**
 * How Object Sets use the query kernel, from EIGOS_KERNEL: `off`; `route`, so the kernel answers what it can and the
 * reference the rest; or `shadow`, so the reference answers and the kernel's answer is compared with it.
 */
export type KernelMode = 'off' | 'route' | 'shadow';
export function kernelMode(): KernelMode {
  const mode = process.env.EIGOS_KERNEL ?? 'off';
  if (mode !== 'off' && mode !== 'route' && mode !== 'shadow') throw new Error('EIGOS_KERNEL must be off, route or shadow');
  return mode;
}

/** `client` is set once the kernel runs; `closed` marks an instance set aside while its kernel was still starting. */
type Instance = { client?: KernelClient; ready: Promise<void>; state: 'loading' | 'ready' | 'failed'; used: number; failedAt?: number; closed?: true };

/**
 * The query kernels this process uses, each holding one projection that it loads on first use and then keeps current.
 * - With EIGOS_KERNEL_URL, one kernel service, which loads whichever projection a query needs.
 * - With EIGOS_KERNEL_BIN, local kernel processes, at most EIGOS_KERNEL_INSTANCES (default 2); the least recently used
 *   one stops when another projection needs one.
 * The kernel reads the database at EIGOS_KERNEL_DATABASE_URL, or at the runtime's own connection string.
 */
export class KernelRegistry {
  private readonly instances = new Map<string, Instance>();
  /** `retryAfterMs` is how long a projection whose kernel failed to load it, or was lost, stays on the reference path. */
  constructor(private readonly url = process.env.EIGOS_KERNEL_URL, private readonly binary = process.env.EIGOS_KERNEL_BIN,
    private readonly limit = Number(process.env.EIGOS_KERNEL_INSTANCES ?? 2), private readonly database = process.env.EIGOS_KERNEL_DATABASE_URL,
    private readonly retryAfterMs = 60_000) {}

  /**
   * A kernel holding the model's projection of `db`, or undefined while it loads (unless `wait`), after it failed to
   * load, or when no kernel is configured.
   */
  async kernelFor(db: Database, model: PublishedOntology, wait: boolean): Promise<KernelClient | undefined> {
    const database = this.databaseOf(db);
    if (!database || !this.url && !this.binary) return undefined;
    const key = this.key(db, model);
    let instance = this.instances.get(key);
    if (instance?.state === 'failed' && Date.now() - instance.failedAt! >= this.retryAfterMs) { this.close(key); instance = undefined; }
    instance ??= this.open(key, db, model, database);
    instance.used = Date.now();
    if (wait) await instance.ready;
    return instance.state === 'ready' ? instance.client : undefined;
  }

  /**
   * Registers the instance before anything is awaited, so concurrent queries for one projection share one kernel; a
   * kernel started for an instance set aside meanwhile is stopped.
   */
  private open(key: string, db: Database, model: PublishedOntology, database: string): Instance {
    if (this.url) {
      // A kernel service holds one projection, so loading another replaces it.
      for (const other of [...this.instances.keys()]) this.instances.delete(other);
    } else {
      while (this.instances.size >= Math.max(1, this.limit)) {
        const [oldest] = [...this.instances.entries()].sort(([, a], [, b]) => a.used - b.used)[0]!;
        this.close(oldest);
      }
    }
    const instance: Instance = { state: 'loading', used: Date.now(), ready: Promise.resolve() };
    this.instances.set(key, instance);
    const start = async () => {
      const client = this.url ? KernelClient.connect(this.url) : await KernelClient.start(this.binary!);
      instance.client = client;
      if (instance.closed) { await client.stop(); throw new Error('Kernel set aside while it started'); }
      // A kernel service may already hold the projection, loaded by another process of this deployment; it keeps it
      // current itself, so loading it again would only repeat the work.
      if (this.url && (await client.health()).projection === model.projection) return;
      await client.load(db, model, database);
    };
    instance.ready = start().then(() => { instance.state = 'ready'; }, () => { instance.state = 'failed'; instance.failedAt = Date.now(); });
    return instance;
  }

  /** Loads the model's projection again, from storage, into the kernel that holds it. */
  async reload(db: Database, model: PublishedOntology) {
    const instance = this.instances.get(this.key(db, model));
    if (instance?.state === 'ready') await instance.client!.load(db, model, this.databaseOf(db)!);
  }

  /**
   * Sets aside the kernel of the model's projection after it was lost, for example because the kernel service
   * restarted: queries go to the reference until the retry delay passes, and the next query then opens it again.
   */
  lost(db: Database, model: PublishedOntology) {
    const instance = this.instances.get(this.key(db, model));
    if (instance?.state === 'ready') { instance.state = 'failed'; instance.failedAt = Date.now(); }
  }

  private databaseOf(db: Database) { return this.database ?? (db.pool.options as { connectionString?: string }).connectionString; }
  private key(db: Database, model: PublishedOntology) { return JSON.stringify([this.databaseOf(db), db.schema, model.projection]); }

  private close(key: string) {
    const instance = this.instances.get(key);
    this.instances.delete(key);
    if (!instance) return;
    instance.closed = true;
    if (instance.client && !this.url) void instance.client.stop();
  }

  /** Stops every kernel process this registry started. */
  async stop() {
    const instances = [...this.instances.keys()];
    for (const key of instances) this.close(key);
  }
}

let shared: KernelRegistry | undefined;
/** The process's kernels, configured from the environment. */
export function defaultKernels() { return shared ??= new KernelRegistry(); }
