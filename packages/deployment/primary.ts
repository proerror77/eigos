import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import http from 'node:http';

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
export function readPrimaryHealth(port:number,host:string):Promise<Record<string,unknown>> {
  return new Promise((resolve,reject)=>{
    const request=http.get({hostname:'127.0.0.1',port,path:'/health',headers:{Host:host}},response=>{
      let body='',bytes=0;response.on('error',reject);
      response.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>65536)response.destroy(new Error('Primary readiness response exceeds its bound'));else body+=chunk.toString('utf8');});
      response.on('end',()=>{try{if(response.statusCode!==200)throw new Error('Primary readiness is unavailable');const value:unknown=JSON.parse(body);if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('Primary readiness is invalid');resolve(value as Record<string,unknown>);}catch(error){reject(error);}});
    });
    request.on('error',reject);request.setTimeout(2000,()=>request.destroy(new Error('Primary readiness timed out')));
  });
}
