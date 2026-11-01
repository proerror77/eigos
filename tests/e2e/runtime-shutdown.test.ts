import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

test('the managed runtime lets a Worker finish its durable shutdown after ten seconds',{timeout:25000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'eigos-shutdown-')),marker=join(root,'recovery-saved');
 mkdirSync(join(root,'scripts'));mkdirSync(join(root,'dist/apps/gateway'),{recursive:true});mkdirSync(join(root,'dist/apps/worker'),{recursive:true});
 writeFileSync(join(root,'scripts/run-local.mjs'),readFileSync(resolve('scripts/run-local.mjs')));
 writeFileSync(join(root,'package.json'),JSON.stringify({type:'module'}));
 writeFileSync(join(root,'dist/apps/gateway/main.js'),"process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);console.log('gateway-ready');");
 writeFileSync(join(root,'dist/apps/worker/main.js'),`import{writeFileSync}from'node:fs';process.on('SIGTERM',()=>setTimeout(()=>{writeFileSync(${JSON.stringify(marker)},'saved');process.exit(0);},12500));setInterval(()=>{},1000);console.log('worker-ready');`);
 const child=spawn(process.execPath,['scripts/run-local.mjs','--built'],{cwd:root,detached:true,env:{...process.env,EIGOS_MANAGED_COMMERCE_SANDBOX:'false',EIGOS_FREE_BOOKING_BROWSER_CONFIG:''},stdio:['ignore','pipe','pipe']});
 let output='';
 try{
  await new Promise<void>((done,reject)=>{
   const timer=setTimeout(()=>reject(new Error('Synthetic runtime did not become ready')),5000);
   child.once('error',reject);child.stdout.on('data',chunk=>{output+=String(chunk);if(output.includes('gateway-ready')&&output.includes('worker-ready')){clearTimeout(timer);done();}});
  });
  const ended=once(child,'exit');assert(child.kill('SIGTERM'));const [code]=await ended;
  assert.equal(code,0);assert(existsSync(marker),'The host killed its Worker before the recovery record could be saved');
  assert.equal(readFileSync(marker,'utf8'),'saved');
 }finally{
  if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}
  rmSync(root,{recursive:true,force:true});
 }
});

test('the managed runtime still forcibly stops unresponsive children after its bounded grace',{timeout:5000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'eigos-forced-shutdown-')),observed=join(root,'grace-ms');
 mkdirSync(join(root,'scripts'));writeFileSync(join(root,'package.json'),JSON.stringify({type:'module'}));
 writeFileSync(join(root,'scripts/run-local.mjs'),readFileSync(resolve('scripts/run-local.mjs')));
 for(const role of ['gateway','worker']){
  mkdirSync(join(root,'dist/apps',role),{recursive:true});
  writeFileSync(join(root,'dist/apps',role,'main.js'),`process.on('SIGTERM',()=>{});setInterval(()=>{},1000);console.log('${role}-ready');`);
 }
 // Observe the real host deadline and accelerate only that parent's timer.
 // Child processes still receive SIGTERM, ignore it, then receive real SIGKILL.
 writeFileSync(join(root,'clock.mjs'),`import{writeFileSync}from'node:fs';const timer=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>{if(ms>=60000){writeFileSync(${JSON.stringify(observed)},String(ms));return timer(fn,50,...args);}return timer(fn,ms,...args);};`);
 const child=spawn(process.execPath,['--import',join(root,'clock.mjs'),'scripts/run-local.mjs','--built'],{cwd:root,detached:true,env:{...process.env,EIGOS_MANAGED_COMMERCE_SANDBOX:'false',EIGOS_FREE_BOOKING_BROWSER_CONFIG:''},stdio:['ignore','pipe','pipe']});
 let output='';
 try{
  await new Promise<void>((done,reject)=>{
   const timer=setTimeout(()=>reject(new Error('Synthetic runtime did not become ready')),3000);
   child.once('error',reject);child.stdout.on('data',chunk=>{output+=String(chunk);if(output.includes('gateway-ready')&&output.includes('worker-ready')){clearTimeout(timer);done();}});
  });
  const ended=once(child,'exit');assert(child.kill('SIGTERM'));const [code]=await ended;
  assert.equal(code,0);assert.equal(readFileSync(observed,'utf8'),'90000');
 }finally{
  if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}
  rmSync(root,{recursive:true,force:true});
 }
});
