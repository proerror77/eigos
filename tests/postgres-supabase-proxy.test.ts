import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {once} from 'node:events';
import pg from 'pg';
import {supabaseProxyOptions} from '../packages/postgres/supabase-proxy.js';

test('Supabase proxy transport is explicit and rejects other destinations, remote proxies and URL credentials',()=>{
  assert.deepEqual(supabaseProxyOptions('other.example',5432),{});
  for(const [host,port,url] of [
    ['supabase.com.attacker.example',5432,'http://127.0.0.1:7890'],['db.example',5432,'http://127.0.0.1:7890'],
    ['db.synthetic.supabase.co',5432,'http://remote.example:7890'],['db.synthetic.supabase.co',5432,'https://127.0.0.1:7890'],
    ['db.synthetic.supabase.co',5432,'http://secret:password@127.0.0.1:7890'],['db.synthetic.supabase.co',5432,'http://127.0.0.1:7890/config'],
    ['db.synthetic.supabase.co',0,'http://127.0.0.1:7890'],
    ['db.synthetic.supabase.co',5432,'invalid-secret-url'],
  ] as const)assert.throws(()=>supabaseProxyOptions(host,port,url),/Invalid Supabase/);
});

async function proxyFixture(reply:string,forward=false){
  const sockets=new Set<net.Socket>();
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));
    socket.once('data',header=>{
      assert.equal(header.toString(),'CONNECT db.synthetic.supabase.co:5432 HTTP/1.1\r\nHost: db.synthetic.supabase.co:5432\r\n\r\n');
      if(forward){
        const target=net.connect(Number(process.env.PGPORT),process.env.PGHOST);sockets.add(target);target.on('error',()=>socket.destroy());target.once('close',()=>sockets.delete(target));
        target.once('connect',()=>{socket.write(reply);socket.pipe(target);target.pipe(socket);});
      }else socket.write(reply);
    });
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address!=='string');
  const options=supabaseProxyOptions('db.synthetic.supabase.co',5432,`http://127.0.0.1:${address.port}`);
  return {options,close:async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}

test('Supabase CONNECT handles rejection and bounded headers without exposing the proxy response',async()=>{
  for(const reply of ['HTTP/1.1 407 SECRET_PROXY_RESPONSE\r\n\r\n','x'.repeat(17000)]){
    const f=await proxyFixture(reply),stream=f.options.stream!();
    try{const error=once(stream,'error');stream.connect(5432,'db.synthetic.supabase.co');const [failure]=await error;assert(!String(failure).includes('SECRET_PROXY_RESPONSE'));}
    finally{stream.destroy();await f.close();}
  }
});

test('Supabase proxy cannot change its pinned destination',async()=>{
  const f=await proxyFixture('HTTP/1.1 200 OK\r\n\r\n'),stream=f.options.stream!();
  try{const error=once(stream,'error');stream.connect(5432,'other.supabase.co');const [failure]=await error;assert.match(String(failure),/destination changed/);}
  finally{stream.destroy();await f.close();}
});

test('real PostgreSQL authentication and query use the explicit CONNECT stream',
  {skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'||process.env.PGHOST!=='127.0.0.1'},async()=>{
  const f=await proxyFixture('HTTP/1.1 200 Connection established\r\n\r\n',true);
  const client=new pg.Client({host:'db.synthetic.supabase.co',port:5432,...f.options,ssl:false,connectionTimeoutMillis:5000});
  try{await client.connect();assert.equal((await client.query('SELECT 73 AS result')).rows[0].result,73);}
  finally{await client.end();await f.close();}
});
