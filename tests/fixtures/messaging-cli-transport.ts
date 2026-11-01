import { loopbackFetch } from './loopback-fetch.js';

const origin = process.env.EIGOS_TEST_ORIGIN, local = process.env.EIGOS_TEST_HTTP;
if (origin !== 'https://messaging.example' || !local || !/^http:\/\/127\.0\.0\.1:\d+$/.test(local)) throw new Error('Synthetic PA CLI transport requires exact fixture origins');
globalThis.fetch = loopbackFetch(() => new Map([[origin, local]]));
