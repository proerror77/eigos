import {Socket} from 'node:net';
import {Duplex,type Writable} from 'node:stream';

/** PostgreSQL ignores HTTP_PROXY. This optional local CONNECT transport is
 * selected explicitly for Supabase only. TLS remains end to end in pg, with
 * the original database hostname and certificate verification unchanged. */
export function supabaseProxyOptions(host:string,port:number,proxyUrl?:string){
  if(proxyUrl===undefined)return {};
  let proxy:URL;try{proxy=new URL(proxyUrl);}catch{throw new Error('Invalid Supabase local proxy configuration');}
  if(!/^(?:[a-z0-9-]+\.)+supabase\.(?:com|co)$/i.test(host)||!Number.isSafeInteger(port)||port<1||port>65535
    ||proxy.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(proxy.hostname)||!proxy.port
    ||proxy.username||proxy.password||proxy.search||proxy.hash||proxy.pathname!=='/')throw new Error('Invalid Supabase local proxy configuration');
  const target=Object.freeze({host,port,proxyHost:proxy.hostname.replace(/^\[|\]$/g,''),proxyPort:Number(proxy.port)});
  return {stream:()=>new SupabaseProxyStream(target)};
}

type Target={host:string;port:number;proxyHost:string;proxyPort:number};
class SupabaseProxyStream extends Duplex {
  private readonly socket=new Socket();
  private phase:'idle'|'headers'|'tunnel'='idle';
  private headers=Buffer.alloc(0);
  private timer?:ReturnType<typeof setTimeout>;
  constructor(private readonly target:Target){
    super({allowHalfOpen:false});
    this.socket.on('error',()=>this.destroy(new Error('Supabase proxy transport failed')));
    this.socket.on('end',()=>this.push(null));
    this.socket.on('close',()=>{if(!this.destroyed)this.destroy();});
    this.socket.on('data',(chunk:Buffer)=>{
      if(this.phase==='tunnel'){if(!this.push(chunk))this.socket.pause();return;}
      this.headers=Buffer.concat([this.headers,chunk]);
      const end=this.headers.indexOf('\r\n\r\n');
      if(end<0){if(this.headers.length>16384)this.destroy(new Error('Supabase proxy response exceeded its header bound'));return;}
      if(end>16384||!/^HTTP\/1\.[01] 200(?: |\r)/.test(this.headers.subarray(0,end).toString('latin1'))){this.destroy(new Error('Supabase proxy CONNECT was rejected'));return;}
      const remaining=this.headers.subarray(end+4);this.headers=Buffer.alloc(0);this.phase='tunnel';clearTimeout(this.timer);
      this.emit('connect');if(remaining.length&&!this.push(remaining))this.socket.pause();
    });
  }
  connect(port:number,host:string){
    if(this.phase!=='idle'||port!==this.target.port||host!==this.target.host){queueMicrotask(()=>this.destroy(new Error('Supabase proxy destination changed')));return this;}
    this.phase='headers';this.timer=setTimeout(()=>this.destroy(new Error('Supabase proxy CONNECT timed out')),15000);this.timer.unref();
    this.socket.connect(this.target.proxyPort,this.target.proxyHost,()=>{
      const authority=`${this.target.host}:${this.target.port}`;
      this.socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });return this;
  }
  setNoDelay(enabled=true){this.socket.setNoDelay(enabled);return this;}
  setKeepAlive(enabled=false,delay=0){this.socket.setKeepAlive(enabled,delay);return this;}
  ref(){this.socket.ref();return this;}
  unref(){this.socket.unref();return this;}
  override _read(){this.socket.resume();}
  override _write(chunk:unknown,encoding:BufferEncoding,callback:(error?:Error|null)=>void){
    if(this.phase!=='tunnel'){callback(new Error('Supabase proxy tunnel is not ready'));return;}
    this.socket.write(chunk as Parameters<Writable['write']>[0],encoding,callback);
  }
  override _final(callback:(error?:Error|null)=>void){this.socket.end(callback);}
  override _destroy(error:Error|null,callback:(error?:Error|null)=>void){clearTimeout(this.timer);this.socket.destroy();callback(error);}
}
