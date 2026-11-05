import {existsSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {RelayClient} from '../../packages/agent-transport/client.js';
import {RideRelayService} from '../../packages/agent-transport/ride-service.js';
import {rideAgentConfigSchema} from '../../packages/agent-transport/ride-agent-config.js';
import {PaRideConnector} from '../../packages/capabilities/rides/connector.js';
import {rideTokenSchema} from '../../packages/capabilities/rides/contracts.js';
import {readRideConnection} from '../../packages/capabilities/rides/connection.js';
import {readPrivateJson} from '../../packages/relay/files.js';
const path=process.env.EIGOS_RIDE_SOURCE_AGENT_FILE;if(!path)throw new Error('EIGOS_RIDE_SOURCE_AGENT_FILE is required');
const config=rideAgentConfigSchema.parse(readPrivateJson(path));
if(!config.enabled||!config.partnerApproved)throw new Error('Ride source is disabled until explicitly enabled and partner-approved');
if(!existsSync(config.credentialPath))throw new Error('An already enrolled Relay credential is required; this entry does not provision one');
const connector=new PaRideConnector(config.binding,{enabled:config.enabled,partnerApproved:config.partnerApproved},{
 readConnection(){return readRideConnection(config.connectionFile);},
 async loadToken(_binding,signal){signal.throwIfAborted();return rideTokenSchema.parse(readPrivateJson(config.tokenFile));},
 async resolveUberRider(_binding,signal){signal.throwIfAborted();const rider=rideTokenSchema.parse(readPrivateJson(config.tokenFile)).riderId;if(!rider)throw new Error('Original OAuth rider mapping is required');return rider;},
});connector.assertCurrentBinding();
const client=await RelayClient.open({baseUrl:config.relayUrl,credentialPath:config.credentialPath,statePath:config.statePath,displayName:config.displayName}),service=new RideRelayService(client,{version:config.version,authorityId:config.authorityId,gatewayAgentId:config.gatewayAgentId,gatewayOrigin:config.gatewayOrigin,ledgerPath:config.ledgerPath,binding:config.binding},connector,undefined,event=>console.error(JSON.stringify({event:'ride_source_authorization',at:new Date().toISOString(),...event}))),stop=new AbortController();
process.on('SIGTERM',()=>stop.abort());process.on('SIGINT',()=>stop.abort());
try{while(!stop.signal.aborted){try{await client.listen(message=>service.handle(message,stop.signal),stop.signal,{concurrency:1});}catch{if(!stop.signal.aborted)await delay(1000,undefined,{signal:stop.signal}).catch(()=>{});}}}finally{service.close();client.close();}
