import { lstat, mkdir, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { Conflict, digest } from '../core/identity.js';
import {
  diningMiniProgramCapabilities as capabilities, diningMiniProgramObservation, diningMiniProgramRead, diningMiniProgramTestRequest,
} from '../ontology/dining-reservations.js';
import { diningSandbox, diningSandboxOrigin } from '../capabilities/dining/sandbox.js';
import type { OntologyClient } from './client.js';

const pendingRequest = z.object({
  kind: z.literal('pa-request'), taskId: z.uuid(), requestId: z.uuid(), capability: z.string(),
  input: z.record(z.string(), z.unknown()),
});
type PendingRequest = z.infer<typeof pendingRequest>;
export type MiniProgramAvailabilityReader = (
  query: z.infer<typeof diningMiniProgramRead>, signal: AbortSignal,
) => Promise<z.infer<typeof diningMiniProgramObservation>>;

export const diningMiniProgramPASandbox = z.strictObject({
  id: diningMiniProgramTestRequest.shape.testId,
  origin: diningSandboxOrigin,
  privateDirectory: z.string().refine(isAbsolute),
  timeZone: z.string().min(1),
});

export class DiningMiniProgramPA {
  constructor(private readonly options: {
    ontology: Pick<OntologyClient, 'request'>;
    readAvailability?: MiniProgramAvailabilityReader;
    sandbox?: z.infer<typeof diningMiniProgramPASandbox>;
  }) {}

  private async pending(taskId: string, signal: AbortSignal) {
    const task = await this.options.ontology.request<{ id: string; state: string; result: unknown }>(`tasks/${taskId}`, undefined, signal);
    const request = pendingRequest.parse(task.result);
    if (task.id !== taskId || request.taskId !== taskId || task.state !== 'input-required')
      throw new Conflict('This task is not waiting for its dining mini-program response');
    return request;
  }

  async answer(taskId: string, signal = AbortSignal.timeout(90000)) {
    const request = await this.pending(z.uuid().parse(taskId), signal);
    const response = await this.execute(request, signal);
    return this.options.ontology.request(`tasks/${taskId}/pa-response`, { requestId: request.requestId, response }, signal);
  }

  private async execute(request: PendingRequest, signal: AbortSignal) {
    if (request.capability === capabilities.availability) {
      if (!this.options.readAvailability) throw new Conflict('Configure the PA’s Android mini-program reader');
      return diningMiniProgramObservation.parse(await this.options.readAvailability(diningMiniProgramRead.parse(request.input), signal));
    }
    if (request.capability !== capabilities.lookupTest && request.capability !== capabilities.submitTest)
      throw new Conflict('This request is outside the PA’s dining mini-program capabilities');
    const input = diningMiniProgramTestRequest.parse(request.input);
    const configuration = diningMiniProgramPASandbox.parse(this.options.sandbox);
    if (input.testId !== configuration.id) throw new Conflict('This request belongs to a different test merchant');
    const sandbox = diningSandbox(configuration.origin, configuration.timeZone);
    if (request.capability === capabilities.lookupTest) {
      try {
        const receipt = await sandbox.lookup(input.terms, input.reference, signal);
        if (receipt) return { status: 'found', receipt };
      } catch { signal.throwIfAborted(); }
      return { status: 'unresolved' };
    }

    await mkdir(configuration.privateDirectory, { recursive: true, mode: 0o700 });
    const info = await lstat(configuration.privateDirectory);
    if (!info.isDirectory() || info.mode & 0o077 || info.uid !== process.getuid?.())
      throw new Conflict('Use a private directory owned by the PA for test submissions');
    const filename = join(configuration.privateDirectory, digest([input.testId, input.reference]) + '.dispatched');
    if (await lstat(filename).catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    })) return { status: 'unknown' };
    try {
      await sandbox.submit(input.terms, input.reference, signal, async send => {
        if (digest(await this.pending(request.taskId, signal)) !== digest(request))
          throw new Conflict('The original test dispatch is no longer pending');
        signal.throwIfAborted();
        const claim = await open(filename, 'wx', 0o600);
        try { await claim.sync(); } finally { await claim.close(); }
        return send();
      });
      return { status: 'attempted' };
    } catch {
      signal.throwIfAborted();
      return { status: 'unknown' };
    }
  }
}
