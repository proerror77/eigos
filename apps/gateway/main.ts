import { createGateway,createPostgresApp } from './app.js';
import { readConfig } from '../../packages/core/config.js';
import type {GatewayApplicationFactory,GatewayRuntimePorts} from './runtime-ports.js';
import {TaskRelayGateway,mountTaskRelay} from './relay.js';
import {mountMessagingMemberRoutes} from './messaging/routes.js';

const config = readConfig();
if (config.DATABASE_PATH === ':memory:') throw new Error('Separate Gateway and Worker require a shared database file');
const postgres:GatewayApplicationFactory=async selected=>{
  const {createPostgresPrimaryHostResources,createPostgresGatewayServices,createPostgresRelayServices,assertPostgresBuiltinSourceConfiguration}=await import('../../packages/postgres/host-runtime.js');
  assertPostgresBuiltinSourceConfiguration(selected);
  const resources=await createPostgresPrimaryHostResources(selected,'gateway');
  let communications:Awaited<ReturnType<typeof createPostgresRelayServices>>,relay:TaskRelayGateway|undefined,closing:Promise<void>|undefined;
  const close=()=>closing??=(async()=>{const errors:unknown[]=[];
    for(const action of [()=>communications?.close(),()=>relay?.close(),()=>resources.close()])try{await action();}catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError(errors,'PostgreSQL Gateway runtime shutdown failed');
  })();
  try{
    const services=createPostgresGatewayServices(selected,resources);
    communications=await createPostgresRelayServices(selected,resources);
    if(communications)relay=new TaskRelayGateway(communications.port,services.tasks,selected.PUBLIC_URL,communications.configuration,selected.EIGOS_DIDI_RELAY_AGENT_ID,
      {openClient:communications.openClient,enrollmentKey:communications.enrollmentKey});
    const messaging=communications?.messaging,taskRelay=relay,relayPort=communications?.port;
    const runtime:GatewayRuntimePorts={backend:'postgres',authority:resources.binding.authority,tasks:services.tasks,members:services.members,definitions:services.definitions,
      security:{permissions:services.permissions,authenticate:(principal,bearer)=>services.publisher.authenticate(principal,bearer),available:services.available,onUnavailable:resources.onUnavailable},
      relay:taskRelay&&relayPort?{status:()=>taskRelay.status,mount:(app,authenticate,principal)=>mountTaskRelay(app,taskRelay,relayPort,authenticate,principal)}:undefined,
      messaging:messaging?{service:messaging,mountMembers:app=>mountMessagingMemberRoutes(app,selected,services.members,messaging)}:undefined,
      authorityCurrent:resources.authorityCurrent,ontologyRelease:services.ontologyRelease,
      start:async()=>{try{await resources.startPublisher();await communications?.verifyMigrations();await taskRelay?.start();resources.assertAvailable();}catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'PostgreSQL Gateway startup failed',{cause:error});}throw error;}},close};
    return await createPostgresApp(selected,runtime);
  }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'PostgreSQL Gateway startup failed',{cause:error});}throw error;}
};
const gateway = await createGateway(config,config.EIGOS_STORAGE_BACKEND==='postgres'?postgres:undefined);
try{await gateway.start();}catch(error){try{await gateway.close();}catch(cleanup){throw new AggregateError([error,cleanup],'Gateway startup and shutdown failed',{cause:error});}throw error;}
const server = gateway.app.listen(config.PORT, config.HOST, () => {
  console.log(`EIGOS Gateway listening at ${config.PUBLIC_URL}; auth=${config.EIGOS_AUTH_MODE}`);
  if (process.env.EIGOS_RELAY_CUTOVER_SIGNALS === 'true' && process.connected) process.send?.({ type: 'relay-cutover-gateway-ready' }, error => { if (error) stop(1); });
});
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true; process.exitCode = code;
  // End polling responses before waiting for HTTP connections to drain.
  void gateway.tasks.close();
  server.close(() => { void gateway.close().then(() => { if (process.connected) process.disconnect(); }, () => { process.exitCode = 1; if (process.connected) process.disconnect(); }); });
};
// The resident supervisor restarts the whole process group. New startup must
// acquire the manager lease and recheck membership; it never renews grants.
gateway.onUnavailable(() => stop(1));
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());
if (process.env.EIGOS_RELAY_CUTOVER_SIGNALS === 'true' && process.send) process.on('disconnect', () => stop(1));
