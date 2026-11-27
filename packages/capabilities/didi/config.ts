import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { DidiMcpConnector } from './connector.js';
import { didiBindingSchema } from './contracts.js';
import type { SourceResolver } from './functions.js';
import { Conflict, digest, SourceReadFailure } from '../../core/identity.js';
import { readPrivateSourceFile } from '../../core/private-source.js';
import { DidiOperations } from './operations.js';
import { z } from 'zod';

const connectionSchema = z.strictObject({
  owner: z.string().min(1), active: z.boolean(), expiresAt: z.iso.datetime().nullable().optional(),
  binding: didiBindingSchema, ordersEnabled: z.boolean().default(false), cancellationsEnabled: z.boolean().optional(),
});
const sandboxWatchSchema = connectionSchema.extend({
  binding: didiBindingSchema.extend({ environment: z.literal('mock') }),
  ordersEnabled: z.literal(false).default(false),
  cancellationsEnabled: z.literal(false).optional(),
  originalOrderId: z.string().min(1).max(500),
});
export function configuredSource(primaryPath?: string, sandboxWatchPath?: string): SourceResolver {
  const cache = new Map<boolean, { hash: string; connector: DidiMcpConnector }>();
  const read = async (path?: string) => {
    if (!path || !isAbsolute(path))
      throw new SourceReadFailure('Configure an absolute DiDi connection file', { unavailable: true });
    try {
      return connectionSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    } catch (cause) {
      throw new SourceReadFailure('DiDi connection configuration is unavailable', { cause, unavailable: true });
    }
  };
  return async (owner, order) => {
    const primary = await read(primaryPath);
    // Tracking supplies the binding from its stored order. Other calls select the primary connection.
    const sandbox = order !== undefined && order.bindingId !== primary.binding.bindingId;
    const readSandbox = async () => {
      if (!sandboxWatchPath)
        throw new SourceReadFailure('DiDi sandbox tracking is unavailable', { unavailable: true });
      try {
        return sandboxWatchSchema.parse(JSON.parse(await readPrivateSourceFile(sandboxWatchPath)));
      } catch (cause) {
        throw new SourceReadFailure('DiDi sandbox connection configuration is unavailable', { cause, unavailable: true });
      }
    };
    const sandboxConnection = sandbox ? await readSandbox() : undefined;
    const connection = sandboxConnection ?? primary;
    if (sandboxConnection && sandboxConnection.binding.bindingId !== order?.bindingId)
      throw new Conflict('Invalid DiDi sandbox watch binding');
    if (sandboxConnection && sandboxConnection.originalOrderId !== order?.orderId)
      throw new Conflict('Original sandbox order identity changed');
    const hash = digest(connection);
    if (!connection.active || connection.owner !== owner || connection.expiresAt && Date.parse(connection.expiresAt) <= Date.now())
      throw new SourceReadFailure('DiDi source is unavailable for this owner', { unavailable: true });
    const cached = cache.get(sandbox);
    const connector = cached?.hash === hash ? cached.connector : new DidiMcpConnector(connection.binding);
    cache.set(sandbox, { hash, connector });
    // The cancel switch can change independently of the original order's authority.
    const { cancellationsEnabled, ...authority } = connection;
    const orders = new DidiOperations(connection.binding, connection.ordersEnabled, fetch, sandboxConnection?.originalOrderId,
      cancellationsEnabled ?? connection.ordersEnabled);
    return { bindingId: connection.binding.bindingId, authorityId: digest(authority), connector, orders, async assertCurrent() {
      if (digest(await (sandbox ? readSandbox() : read(primaryPath))) !== hash ||
        connection.expiresAt && Date.parse(connection.expiresAt) <= Date.now())
        throw new Conflict('DiDi source configuration changed or expired');
      await connector.verifyCredential();
    } };
  };
}
