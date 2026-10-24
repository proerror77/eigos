import { readWorkerConfig } from '../../packages/core/config.js';
import { createParticipantBrowserBridge } from '../../packages/capabilities/free-booking/browser-bridge.js';
import { readParticipantRuntime, participantRuntimeCredentials, participantDeploymentSettings } from '../../packages/capabilities/free-booking/runtime-config.js';

const file = process.env.EIGOS_FREE_BOOKING_BROWSER_CONFIG;
if (!file || !process.env.DATABASE_PATH) throw new Error('Managed participant browser configuration and resident task database are required');
const config = readParticipantRuntime(file, process.env.DATABASE_PATH);
const settings = participantDeploymentSettings(process.env, {}, process.env.DATABASE_PATH);
readWorkerConfig({ ...process.env, ...settings });
const bridge = await createParticipantBrowserBridge({ ...config, ...participantRuntimeCredentials(config) });
console.log(JSON.stringify({ role: 'participant-browser', endpoint: bridge.endpoint, operatorRequired: true, unattended: false }));
let stopping = false;
const stop = async () => { if (!stopping) { stopping = true; await bridge.close(); } };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
