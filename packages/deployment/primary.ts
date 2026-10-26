import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import http from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';

export const primaryRuntime = (home=homedir()) => join(home,'.local/share/eigos/primary');
export function assertLegacyDeploymentAllowed(home=homedir()): void {
  if(existsSync(join(primaryRuntime(home),'authority.json')) || existsSync(join(primaryRuntime(home),'release.json')))
    throw new Error('This host has one primary authority. Update com.eigos.primary; retired profiles cannot create another formal runtime.');
}
export function primaryRelease(home=homedir()): {runtime:string;release:Record<string,string>} {
  const runtime=primaryRuntime(home),path=join(runtime,'release.json'),stat=lstatSync(path);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.uid!==process.getuid?.() || stat.mode&0o077)throw new Error('Use the owned primary deployment record');
  return {runtime,release:JSON.parse(readFileSync(path,'utf8'))};
}

/** Read the loopback backend with the actual registered Host. Node fetch may
 * replace this header, so readiness uses the same explicit HTTP host as the proxy. */
export function readPrimaryHealth(port:number,host:string,timeoutMs=15000):Promise<Record<string,unknown>> {
  return new Promise((resolve,reject)=>{
    if(!Number.isFinite(timeoutMs) || timeoutMs<=0 || timeoutMs>2147483647)throw new Error('Primary readiness timeout must be a positive bounded duration');
    const fail=(error:Error)=>{clearTimeout(deadline);reject(error);};
    const request=http.get({hostname:'127.0.0.1',port,path:'/health',headers:{Host:host}},response=>{
      let body='',bytes=0;response.on('error',fail);
      response.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>65536)response.destroy(new Error('Primary readiness response exceeds its bound'));else body+=chunk.toString('utf8');});
      response.on('end',()=>{clearTimeout(deadline);try{if(response.statusCode!==200)throw new Error(`Primary readiness is unavailable (HTTP ${response.statusCode})`);const value:unknown=JSON.parse(body);if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('Primary readiness is invalid');resolve(value as Record<string,unknown>);}catch(error){reject(error);}});
    });
    // Bound the entire response, including a peer that keeps sending bytes.
    const deadline=setTimeout(()=>request.destroy(new Error(`Primary readiness timed out after ${timeoutMs}ms`)),timeoutMs);
    request.on('error',fail);
  });
}

/** A slow startup may recover, but only this authority and release can be ready. */
export async function waitForPrimaryHealth(
  port:number,host:string,expected:{authorityId:string;releaseDigest:string},
  {timeoutMs=120000,requestTimeoutMs=15000,retryDelayMs=500}:{timeoutMs?:number;requestTimeoutMs?:number;retryDelayMs?:number}={},
):Promise<Record<string,unknown>> {
  for(const duration of [timeoutMs,requestTimeoutMs,retryDelayMs])
    if(!Number.isFinite(duration) || duration<=0 || duration>2147483647)throw new Error('Primary readiness durations must be positive and bounded');
  const deadline=performance.now()+timeoutMs;
  let lastFailure='No probe completed';
  while(performance.now()<deadline){
    try{
      const health=await readPrimaryHealth(port,host,Math.max(1,Math.min(requestTimeoutMs,deadline-performance.now())));
      if(health.status==='ok' && health.authorityId===expected.authorityId && health.releaseDigest===expected.releaseDigest){
        if(performance.now()<deadline)return health;
        lastFailure='Matching response arrived after the readiness deadline';
      }else lastFailure='Health status, authority ID or release digest does not match the deployed primary';
    }catch(error){lastFailure=error instanceof Error?error.message:String(error);}
    const remaining=deadline-performance.now();
    if(remaining>0)await pause(Math.min(retryDelayMs,remaining));
  }
  throw new Error(`Primary failed readiness after ${timeoutMs}ms. Last probe: ${lastFailure}`);
}
