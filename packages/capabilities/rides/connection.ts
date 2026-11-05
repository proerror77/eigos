import {readPrivateJson} from '../../relay/files.js';
import {rideConnectionSchema} from './contracts.js';
/** Metadata only. This file must never contain provider tokens or app secrets. */
export function readRideConnection(path:string){return rideConnectionSchema.parse(readPrivateJson(path,16384));}
