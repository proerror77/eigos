import {digest} from '../../core/delegation.js';
import type {Config} from '../../core/config.js';
import {rideProviders,type RideProvider,type RideBinding} from './contracts.js';
import {readPrivateJson} from '../../relay/files.js';
import {rideConnectionSchema} from './contracts.js';
/** Metadata only. This file must never contain provider tokens or app secrets. */
export function readRideConnection(path:string){return rideConnectionSchema.parse(readPrivateJson(path,16384));}

export interface RideHostConfiguration {binding:RideBinding;peerId:string;enabled:boolean;assertCurrent:()=>void}
/** Primary metadata only; the provider token remains on the PA source node. */
export function rideConnectionsFromConfig(config:Config):Partial<Record<RideProvider,RideHostConfiguration>>{
 const result:Partial<Record<RideProvider,RideHostConfiguration>>={};
 for(const provider of rideProviders){const upper=provider==='uber'?'UBER':'GRAB',enabled=config[`EIGOS_${upper}_RIDES_ENABLED`]==='true';if(!enabled)continue;
  const path=config[`EIGOS_${upper}_RIDES_CONNECTION_FILE`],peerId=config[`EIGOS_${upper}_RIDES_RELAY_AGENT_ID`];if(!path||!peerId||!config.authority||!config.EIGOS_TASK_RELAY_FILE||!config.EIGOS_PERSONAL_SOURCE_OWNER)throw new Error('Ride Relay metadata is incomplete');
  const initial=readRideConnection(path),assertCurrent=()=>{const current=readRideConnection(path);if(current.binding.provider!==provider||current.binding.owner!==config.EIGOS_PERSONAL_SOURCE_OWNER||current.state!=='active'||Date.parse(current.expiresAt)<=Date.now()||digest(current)!==digest(initial))throw new Error('Ride source metadata expired, revoked or changed');};assertCurrent();
  result[provider]={binding:initial.binding,peerId,enabled:true,assertCurrent};
 }return result;
}
