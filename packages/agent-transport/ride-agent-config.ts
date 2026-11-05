import {z} from 'zod';
import {isAbsolute} from 'node:path';
import {rideServiceConfigSchema} from './ride-service.js';
import {relayOrigin} from '../relay/contracts.js';
export const rideAgentConfigSchema=rideServiceConfigSchema.extend({relayUrl:z.string().transform(relayOrigin),credentialPath:z.string().refine(isAbsolute),statePath:z.string().refine(isAbsolute),connectionFile:z.string().refine(isAbsolute),tokenFile:z.string().refine(isAbsolute),enabled:z.boolean().default(false),partnerApproved:z.boolean().default(false),displayName:z.string().min(1).max(80).default('Ride estimate PA source')});
