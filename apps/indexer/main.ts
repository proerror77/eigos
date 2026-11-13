import { setTimeout as delay } from 'node:timers/promises';
import { Database } from '../../packages/runtime/database.js';
import { Indexing } from '../../packages/runtime/indexing.js';
import { Effects } from '../../packages/runtime/effects.js';
import { loadExtensions } from '../../packages/runtime/extensions.js';

if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');
const db=new Database(process.env.DATABASE_URL,process.env.EIGOS_PG_SCHEMA);
const extensions=await loadExtensions(process.env.EIGOS_EXTENSION_MODULE);
const indexing=new Indexing(db),effects=new Effects(db,extensions.effects??new Map());
const controller=new AbortController();
process.on('SIGTERM',()=>controller.abort());process.on('SIGINT',()=>controller.abort());
async function dispatch(){
  while(!controller.signal.aborted){
    if(await effects.runOne(controller.signal))continue;
    await delay(1000,undefined,{signal:controller.signal}).catch(()=>{});
  }
}
try { await Promise.all([indexing.run(controller.signal),dispatch()]); }
finally { controller.abort(); await db.close(); }
