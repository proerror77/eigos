import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { readWorkerConfig } from '../../core/config.js';

const path = z.string().refine(value => isAbsolute(value) && !/[\r\n'"#]/.test(value), 'Use an absolute private path representable in managed settings');
const schema = z.strictObject({
  bindingId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), attendeeRef: z.string().regex(/^[a-f0-9]{64}$/),
  port: z.number().int().min(1).max(65535), gatewayPort: z.number().int().min(1).max(65535).optional(),
  databasePath: path, taskDatabasePath: path, evidenceDirectory: path, workerTokenFile: path, operatorTokenFile: path,
});
export function readParticipantRuntime(file: string, taskDatabasePath: string) {
  path.parse(file);
  const config = schema.parse(JSON.parse(readFileSync(file, 'utf8')));
  if (resolve(config.taskDatabasePath) !== resolve(taskDatabasePath) || resolve(config.databasePath) === resolve(taskDatabasePath)) throw new Error('Participant browser must use the resident task database and a separate source queue');
  return config;
}
export function participantRuntimeCredentials(config: z.infer<typeof schema>) {
  const workerToken = readFileSync(config.workerTokenFile, 'utf8').trim(), operatorToken = readFileSync(config.operatorTokenFile, 'utf8').trim();
  if (![workerToken, operatorToken].every(value => /^[a-f0-9]{64}$/.test(value)) || workerToken === operatorToken) throw new Error('Participant runtime requires distinct valid worker and operator credentials');
  return { workerToken, operatorToken };
}
const keys = ['EIGOS_FREE_BOOKING_BRIDGE_URL', 'EIGOS_FREE_BOOKING_TOKEN_FILE', 'EIGOS_FREE_BOOKING_BINDING_ID', 'EIGOS_FREE_BOOKING_ATTENDEE_SHA256'] as const;
/** Preserve the source binding across installs. An explicitly managed browser
 * config also pins the queue to the resident database before any restart. */
export function participantDeploymentSettings(overrides: NodeJS.ProcessEnv, previous: NodeJS.ProcessEnv, taskDatabasePath: string): Record<string, string> {
  if (overrides.EIGOS_FREE_BOOKING_BRIDGE_URL === '') return {};
  const file = overrides.EIGOS_FREE_BOOKING_BROWSER_CONFIG ?? previous.EIGOS_FREE_BOOKING_BROWSER_CONFIG;
  const values: Record<string, string> = {};
  if (file) {
    const config = readParticipantRuntime(file, taskDatabasePath);
    participantRuntimeCredentials(config);
    Object.assign(values, { EIGOS_FREE_BOOKING_BROWSER_CONFIG: file, EIGOS_FREE_BOOKING_BRIDGE_URL: `http://127.0.0.1:${config.port}`, EIGOS_FREE_BOOKING_TOKEN_FILE: config.workerTokenFile, EIGOS_FREE_BOOKING_BINDING_ID: config.bindingId, EIGOS_FREE_BOOKING_ATTENDEE_SHA256: config.attendeeRef });
    for (const key of keys) if (overrides[key] !== undefined && overrides[key] !== values[key]) throw new Error('Participant binding differs from its managed browser configuration');
  } else {
    for (const key of keys) {
      const value = overrides[key] ?? previous[key];
      if (value !== undefined) values[key] = value;
    }
  }
  readWorkerConfig({ NODE_ENV: 'development', HOST: '127.0.0.1', PUBLIC_URL: 'http://127.0.0.1:3430', EIGOS_AUTH_MODE: 'development', ...values });
  if (values.EIGOS_FREE_BOOKING_TOKEN_FILE) path.parse(values.EIGOS_FREE_BOOKING_TOKEN_FILE);
  return values;
}
