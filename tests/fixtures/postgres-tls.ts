import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import {once} from 'node:events';
import {generateKeyPairSync,sign,X509Certificate} from 'node:crypto';

/** Ephemeral synthetic certificate, generated in memory without a helper
 * process, external CA, persistent key or disabled certificate validation. */
function certificate(){
  const der=(tag:number,...parts:Buffer[])=>{
    const body=Buffer.concat(parts),hex=body.length.toString(16).padStart(Math.ceil(body.length.toString(16).length/2)*2,'0'),bytes=Buffer.from(hex,'hex');
    const length=body.length<128?Buffer.from([body.length]):Buffer.concat([Buffer.from([0x80+bytes.length]),bytes]);
    return Buffer.concat([Buffer.from([tag]),length,body]);
  };
  const oid=(hex:string)=>der(6,Buffer.from(hex,'hex')),seq=(...parts:Buffer[])=>der(0x30,...parts);
  const algorithm=seq(oid('2a864886f70d01010b'),der(5)),pair=generateKeyPairSync('rsa',{modulusLength:2048});
  const name=seq(der(0x31,seq(oid('550403'),der(12,Buffer.from('Synthetic PostgreSQL loopback TLS')))));
  const instant=(time:number)=>der(23,Buffer.from(new Date(time).toISOString().replace(/[-:]/g,'').slice(2,15).replace('T','')+'Z'));
  const extensions=der(0xa3,seq(
    seq(oid('551d13'),der(1,Buffer.from([0xff])),der(4,seq(der(1,Buffer.from([0xff]))))),
    seq(oid('551d11'),der(4,seq(der(0x82,Buffer.from('localhost')))))));
  const now=Date.now(),body=seq(der(0xa0,der(2,Buffer.from([2]))),der(2,Buffer.from([1])),algorithm,name,seq(instant(now-86400000),instant(now+86400000)),name,pair.publicKey.export({format:'der',type:'spki'}),extensions);
  const signed=seq(body,algorithm,der(3,Buffer.concat([Buffer.from([0]),sign('sha256',body,pair.privateKey)])));
  const ca='-----BEGIN CERTIFICATE-----\n'+signed.toString('base64').match(/.{1,64}/g)!.join('\n')+'\n-----END CERTIFICATE-----\n';
  assert(new X509Certificate(ca).verify(pair.publicKey));
  return {ca,key:pair.privateKey.export({format:'pem',type:'pkcs8'})};
}

/** A PostgreSQL SSLRequest terminator that forwards the decrypted protocol
 * bytes unchanged to LOCAL PostgreSQL. It neither synthesizes PostgreSQL
 * replies nor changes the real backend authentication or transaction result.
 * Require the caller's actual backend port; a fallback can hide a mismatch
 * between the administrator connection and the TLS-forwarded runtime login. */
export async function postgresTlsFixture(targetPort:number){
  if(!Number.isInteger(targetPort)||targetPort<1||targetPort>65535)throw new Error('An explicit local target port is required');
  const {ca,key}=certificate(),secureContext=tls.createSecureContext({key,cert:ca});
  const sockets=new Set<net.Socket>(),fronts=new Set<net.Socket>(),errors:Error[]=[];
  let accepted=0,upgrades=0,backendConnections=0,closing:Promise<void>|undefined;
  const track=(socket:net.Socket)=>{sockets.add(socket);socket.on('error',error=>errors.push(error));socket.once('close',()=>sockets.delete(socket));return socket;};
  const server=net.createServer(socket=>{
    accepted++;track(socket);fronts.add(socket);socket.once('close',()=>fronts.delete(socket));
    let pending=Buffer.alloc(0);
    const sslRequest=(data:Buffer)=>{
      pending=Buffer.concat([pending,data]);if(pending.length<8)return;
      socket.off('data',sslRequest);socket.pause();
      if(pending.length!==8||pending.readUInt32BE(0)!==8||pending.readUInt32BE(4)!==80877103){socket.destroy(new Error('Only a PostgreSQL SSLRequest is accepted'));return;}
      socket.write('S',()=>{
        if(socket.destroyed)return;
        const secured=track(new tls.TLSSocket(socket,{isServer:true,secureContext}));
        secured.once('secure',()=>{upgrades++;});
        const backend=track(net.connect({host:'127.0.0.1',port:targetPort}));
        backend.once('connect',()=>{backendConnections++;});
        secured.on('error',()=>backend.destroy());backend.on('error',()=>secured.destroy());
        secured.once('close',()=>backend.destroy());backend.once('close',()=>secured.destroy());
        secured.pipe(backend);backend.pipe(secured);secured.resume();
      });
    };
    socket.on('data',sslRequest);
  });
  server.listen({host:'127.0.0.1',port:0});await once(server,'listening');
  const address=server.address();assert(address&&typeof address!=='string');
  return {ca,port:address.port,host:'localhost' as const,errors,
    stats:()=>({accepted,upgrades,backendConnections,open:[...sockets].filter(socket=>!socket.closed).length}),
    disconnect:()=>{for(const socket of fronts)socket.destroy();},
    drained:()=>Promise.all([...sockets].map(socket=>socket.closed?Promise.resolve():new Promise<void>(resolve=>socket.once('close',()=>resolve())))).then(()=>{}),
    close:()=>closing??=(async()=>{
      const closed=[...sockets].map(socket=>socket.closed?Promise.resolve():new Promise<void>(resolve=>socket.once('close',()=>resolve())));
      for(const socket of sockets)socket.destroy();await Promise.all(closed);
      await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
      assert.equal([...sockets].filter(socket=>!socket.closed).length,0);sockets.clear();fronts.clear();
    })()};
}
