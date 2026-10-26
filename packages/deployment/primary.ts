import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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
