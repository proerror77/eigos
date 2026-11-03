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

async function proxyFixture(reply:string,forward=false,end=false){
  const sockets=new Set<net.Socket>();
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));
    socket.once('data',header=>{
      assert.equal(header.toString(),'CONNECT db.synthetic.supabase.co:5432 HTTP/1.1\r\nHost: db.synthetic.supabase.co:5432\r\n\r\n');
      if(forward){
        const target=net.connect(Number(process.env.PGPORT),process.env.PGHOST);sockets.add(target);target.on('error',()=>socket.destroy());target.once('close',()=>sockets.delete(target));
        target.once('connect',()=>{socket.write(reply);socket.pipe(target);target.pipe(socket);});
      }else if(end)socket.end(reply);else socket.write(reply);
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

// A fresh, synthetic CA/leaf stays in memory. Tests keep normal hostname and
// certificate verification; no spawned helper, external service or real key is used.
async function tlsProxyFixture(closeMode:'graceful'|'pending'|'abrupt'|'reset',trust=true){
  const tls=await import('node:tls'),crypto=await import('node:crypto');
  const der=(tag:number,...parts:Buffer[])=>{const body=Buffer.concat(parts),length=body.length<128?Buffer.from([body.length]):(()=>{const hex=body.length.toString(16).padStart(Math.ceil(body.length.toString(16).length/2)*2,'0'),bytes=Buffer.from(hex,'hex');return Buffer.concat([Buffer.from([0x80+bytes.length]),bytes]);})();return Buffer.concat([Buffer.from([tag]),length,body]);};
  const oid=(hex:string)=>der(6,Buffer.from(hex,'hex')),sequence=(...parts:Buffer[])=>der(0x30,...parts),algorithm=sequence(oid('2a864886f70d01010b'),der(5));
  const pair=crypto.generateKeyPairSync('rsa',{modulusLength:2048}),name=sequence(der(0x31,sequence(oid('550403'),der(12,Buffer.from('Synthetic CONNECT TLS')))));
  const instant=(time:number)=>der(23,Buffer.from(new Date(time).toISOString().replace(/[-:]/g,'').slice(2,15).replace('T','')+'Z'));
  const now=Date.now(),extensions=der(0xa3,sequence(sequence(oid('551d13'),der(1,Buffer.from([0xff])),der(4,sequence(der(1,Buffer.from([0xff]))))),sequence(oid('551d11'),der(4,sequence(der(0x82,Buffer.from('db.synthetic.supabase.co')))))));
  const unsigned=sequence(der(0xa0,der(2,Buffer.from([2]))),der(2,Buffer.from([1])),algorithm,name,sequence(instant(now-86400000),instant(now+86400000)),name,pair.publicKey.export({format:'der',type:'spki'}),extensions);
  const certificate=sequence(unsigned,algorithm,der(3,Buffer.concat([Buffer.from([0]),crypto.sign('sha256',unsigned,pair.privateKey)]))),cert='-----BEGIN CERTIFICATE-----\n'+certificate.toString('base64').match(/.{1,64}/g)!.join('\n')+'\n-----END CERTIFICATE-----\n';
  assert(new crypto.X509Certificate(cert).verify(pair.publicKey));
  const sockets=new Set<net.Socket>(),seen:string[]=[],serverErrors:Error[]=[];let peer:net.Socket|undefined,verified=false;
  const packet=(type:string,body:Buffer)=>{const size=Buffer.alloc(4);size.writeUInt32BE(body.length+4);return Buffer.concat([Buffer.from(type),size,body]);};
  const tlsServer=tls.createServer({key:pair.privateKey.export({format:'pem',type:'pkcs8'}),cert},socket=>{
    sockets.add(socket);socket.on('error',error=>serverErrors.push(error));socket.once('close',()=>sockets.delete(socket));
    let pending=Buffer.alloc(0),startup=true;
    socket.on('data',data=>{
      pending=Buffer.concat([pending,data]);
      while(pending.length>=(startup?4:5)){
        const length=pending.readUInt32BE(startup?0:1),total=length+(startup?0:1);if(pending.length<total)return;
        const request=pending.subarray(0,total);pending=pending.subarray(total);
        if(startup){startup=false;socket.write(Buffer.concat([packet('R',Buffer.alloc(4)),packet('Z',Buffer.from('I'))]));continue;}
        if(request[0]===81){seen.push(request.subarray(5,-1).toString());
          if(closeMode==='reset'){peer!.resetAndDestroy();socket.destroy();}
          else if(closeMode==='abrupt')socket.destroy();
          else if(closeMode==='pending')socket.end();
          else socket.end(Buffer.concat([packet('C',Buffer.from('COMMIT\0')),packet('Z',Buffer.from('I'))]));
        }else if(request[0]===88)socket.end();
      }
    });
  });
  tlsServer.on('tlsClientError',error=>serverErrors.push(error));tlsServer.listen(0,'127.0.0.1');await once(tlsServer,'listening');const tlsAddress=tlsServer.address();assert(tlsAddress&&typeof tlsAddress!=='string');
  const proxy=net.createServer(socket=>{
    peer=socket;sockets.add(socket);socket.on('error',error=>serverErrors.push(error));socket.once('close',()=>sockets.delete(socket));
    socket.once('data',header=>{
      assert.equal(header.toString(),'CONNECT db.synthetic.supabase.co:5432 HTTP/1.1\r\nHost: db.synthetic.supabase.co:5432\r\n\r\n');
      const target=net.connect(tlsAddress.port,'127.0.0.1');sockets.add(target);target.on('error',error=>{serverErrors.push(error);socket.destroy();});target.once('close',()=>sockets.delete(target));
      target.once('connect',()=>{socket.write('HTTP/1.1 200 Connection established\r\n\r\n');socket.once('data',ssl=>{assert.equal(ssl.length,8);assert.equal(ssl.readUInt32BE(4),80877103);socket.write('S');socket.pipe(target);target.pipe(socket);});});
    });
  });
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const address=proxy.address();assert(address&&typeof address!=='string');
  const options=supabaseProxyOptions('db.synthetic.supabase.co',5432,`http://127.0.0.1:${address.port}`),stream=options.stream!(),rawErrors:Error[]=[];stream.on('error',error=>rawErrors.push(error));
  const client=new pg.Client({host:'db.synthetic.supabase.co',port:5432,user:'synthetic',database:'synthetic',stream:()=>stream,ssl:{ca:trust?cert:undefined,rejectUnauthorized:true,checkServerIdentity:(host,certificate)=>{const error=tls.checkServerIdentity(host,certificate);if(!error)verified=true;return error;}},connectionTimeoutMillis:5000});
  const clientErrors:Error[]=[];client.on('error',error=>clientErrors.push(error));
  let closing:Promise<void>|undefined;
  return {client,stream,rawErrors,clientErrors,seen,serverErrors,verified:()=>verified,close:()=>closing??=(async()=>{stream.destroy();await client.end().catch(()=>{});const closed=[...sockets].map(socket=>socket.closed?Promise.resolve():new Promise<void>(resolve=>socket.once('close',()=>resolve())));for(const socket of sockets)socket.destroy();await Promise.all(closed);await Promise.all([new Promise<void>(resolve=>proxy.close(()=>resolve())),new Promise<void>(resolve=>tlsServer.close(()=>resolve()))]);assert.equal([...sockets].filter(socket=>!socket.closed).length,0);sockets.clear();})()};
}

for(const mode of ['graceful','pending','abrupt','reset']as const)test(`verified TLS CONNECT ${mode} close returns once without write-after-end`,{timeout:10000},async t=>{
  const f=await tlsProxyFixture(mode);t.after(()=>f.close());
  try{
    await f.client.connect();assert.equal(f.verified(),true);
    let operationError:Error|undefined;
    if(mode==='graceful')await f.client.query('COMMIT');else await assert.rejects(f.client.query('COMMIT'),error=>{assert(error instanceof Error);assert.match(error.message,/terminated|closed|reset|transport/i);operationError=error;return true;});
    await f.client.end();await new Promise<void>(resolve=>setImmediate(resolve));
    assert.deepEqual(f.seen,['COMMIT'],'An unknown completion is never retried');
    assert.equal(f.rawErrors.some(error=>'code'in error&&error.code==='ERR_STREAM_WRITE_AFTER_END'),false,JSON.stringify(f.rawErrors.map(error=>({message:error.message,code:'code'in error?error.code:undefined}))));
    assert.equal(f.clientErrors.some(error=>'code'in error&&error.code==='ERR_STREAM_WRITE_AFTER_END'),false);
    assert.equal(f.stream.destroyed,true);
    if(mode!=='graceful'){assert(operationError);assert(f.clientErrors.includes(operationError),'The original operation receives the observed transport failure');}
  }finally{await f.close();}
});

test('CONNECT native TLS still rejects an untrusted certificate',{timeout:10000},async t=>{
  const f=await tlsProxyFixture('graceful',false);t.after(()=>f.close());
  await assert.rejects(f.client.connect(),/self.signed|certificate/i);assert.equal(f.verified(),false);assert.deepEqual(f.seen,[]);
});

test('CONNECT rejects a truncated response instead of hanging until the database timeout',{timeout:10000},async()=>{
  const f=await proxyFixture('HTTP/1.1 200 OK\r\n',false,true),stream=f.options.stream!();
  try{const failed=once(stream,'error');stream.connect(5432,'db.synthetic.supabase.co');const [error]=await failed;assert.match(String(error),/CONNECT closed before/);assert.equal(stream.destroyed,true);}
  finally{stream.destroy();await f.close();}
});

test('CONNECT removes its headers and preserves a coalesced first tunnel payload',async()=>{
  const f=await proxyFixture('HTTP/1.1 200 OK\r\nX-Synthetic: private-proxy-header\r\n\r\ntunnel-payload'),stream=f.options.stream!();
  try{const connected=once(stream,'connect'),data=once(stream,'data');stream.connect(5432,'db.synthetic.supabase.co');await connected;const [payload]=await data;assert.equal(payload.toString(),'tunnel-payload');}
  finally{stream.destroy();await f.close();}
});

test('closed CONNECT streams report writes to their callback and cannot reconnect',async()=>{
  const f=await proxyFixture('HTTP/1.1 200 OK\r\n\r\n'),stream=f.options.stream!();const errors:Error[]=[];stream.on('error',error=>errors.push(error));
  try{const connected=once(stream,'connect');stream.connect(5432,'db.synthetic.supabase.co');await connected;const closed=once(stream,'close');stream.destroy();await closed;
    let callbacks=0;const error=await new Promise<Error|null|undefined>(resolve=>stream.write(Buffer.from('synthetic-write'),failure=>{callbacks++;resolve(failure);}));
    assert(error instanceof Error);assert.equal(callbacks,1);assert.equal(stream.destroyed,true);assert.throws(()=>stream.connect(5432,'db.synthetic.supabase.co'),/stream is closed/);
  }finally{stream.destroy();await f.close();}
});

test('CONNECT refuses caller bytes before the tunnel is established',async()=>{
  const f=await proxyFixture('HTTP/1.1 200 OK\r\n\r\n'),stream=f.options.stream!();const errors:Error[]=[];stream.on('error',error=>errors.push(error));
  try{const error=await new Promise<Error|null|undefined>(resolve=>stream.write(Buffer.from('synthetic-premature-write'),failure=>resolve(failure)));assert.match(String(error),/tunnel is not ready/);}
  finally{stream.destroy();await f.close();}
});

test('cancelled CONNECT returns the original operation error and closes its socket',async()=>{
  const f=await proxyFixture(''),stream=f.options.stream!(),client=new pg.Client({host:'db.synthetic.supabase.co',port:5432,stream:()=>stream,ssl:false,connectionTimeoutMillis:5000}),errors:Error[]=[];client.on('error',error=>errors.push(error));
  try{const connecting=client.connect(),reason=new Error('Synthetic CONNECT cancellation');stream.destroy(reason);await assert.rejects(connecting,error=>error===reason);assert.equal(stream.destroyed,true);}
  finally{stream.destroy();await client.end();await f.close();}
});

test('CONNECT refuses vectored caller bytes before the tunnel is established',async()=>{
  const f=await proxyFixture('HTTP/1.1 200 OK\r\n\r\n'),stream=f.options.stream!(),errors:Error[]=[];stream.on('error',error=>errors.push(error));
  try{stream.cork();const first=new Promise<Error|null|undefined>(resolve=>stream.write(Buffer.from('synthetic-one'),failure=>resolve(failure))),second=new Promise<Error|null|undefined>(resolve=>stream.write(Buffer.from('synthetic-two'),failure=>resolve(failure)));stream.uncork();
    for(const error of await Promise.all([first,second]))assert.match(String(error),/tunnel is not ready/);
  }finally{stream.destroy();await f.close();}
});
