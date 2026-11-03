import {Socket} from 'node:net';

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
/** A real Socket lets TLS take ownership of its native handle. A JavaScript
 * Duplex wrapper has a second writable lifecycle: its automatic EOF shutdown
 * can race TLS's own close_notify write and emit WRITE_AFTER_END. */
class SupabaseProxyStream extends Socket {
  private phase:'idle'|'headers'|'tunnel'|'closed'='idle';
  private headers=Buffer.alloc(0);
  private writingConnect=false;
  private timer?:ReturnType<typeof setTimeout>;
  constructor(private readonly target:Target){super();}
  override connect(port:unknown,host?:unknown):this {
    if(this.destroyed||this.writableEnded||this.phase==='closed')throw new Error('Supabase proxy stream is closed');
    if(this.phase!=='idle'||port!==this.target.port||host!==this.target.host){queueMicrotask(()=>this.destroy(new Error('Supabase proxy destination changed')));return this;}
    this.phase='headers';this.timer=setTimeout(()=>this.destroy(new Error('Supabase proxy CONNECT timed out')),15000);this.timer.unref();
    super.connect(this.target.proxyPort,this.target.proxyHost);return this;
  }
  override _write(chunk:Buffer,encoding:BufferEncoding,callback:(error?:Error|null)=>void){
    if(this.phase!=='tunnel'&&!this.writingConnect){callback(new Error('Supabase proxy tunnel is not ready'));return;}
    super._write(chunk,encoding,callback);
  }
  override _writev(chunks:{chunk:Buffer;encoding:BufferEncoding}[],callback:(error?:Error|null)=>void){
    if(this.phase!=='tunnel'&&!this.writingConnect){callback(new Error('Supabase proxy tunnel is not ready'));return;}
    const write=super._writev;if(!write){callback(new Error('Supabase proxy socket vector writes are unavailable'));return;}
    write.call(this,chunks,callback);
  }
  override emit(event:string|symbol,...args:unknown[]):boolean {
    if(event==='connect'&&this.phase==='headers'){
      if(this.destroyed||this.writableEnded){this.destroy(new Error('Supabase proxy CONNECT ended before it was ready'));return false;}
      const authority=`${this.target.host}:${this.target.port}`;
      this.writingConnect=true;try{super.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);}finally{this.writingConnect=false;}
      // Read proxy headers even when an early pg listener queued _read until connect.
      super._read(0);this.resume();return true;
    }
    if(event==='ready'&&this.phase==='headers')return false;
    if(event==='data'&&this.phase==='headers'){
      const chunk=args[0];if(!Buffer.isBuffer(chunk)){this.destroy(new Error('Supabase proxy response was not binary'));return false;}
      this.headers=Buffer.concat([this.headers,chunk]);const end=this.headers.indexOf('\r\n\r\n');
      if(end<0){if(this.headers.length>16384)this.destroy(new Error('Supabase proxy response exceeded its header bound'));return true;}
      if(end>16384||!/^HTTP\/1\.[01] 200(?: |\r)/.test(this.headers.subarray(0,end).toString('latin1'))){this.destroy(new Error('Supabase proxy CONNECT was rejected'));return true;}
      const remaining=this.headers.subarray(end+4);this.headers=Buffer.alloc(0);this.phase='tunnel';clearTimeout(this.timer);
      this.pause();if(remaining.length)this.unshift(remaining);
      super.emit('connect');super.emit('ready');if(this.listenerCount('data'))this.resume();return true;
    }
    if(event==='end'&&this.phase==='headers'){this.destroy(new Error('Supabase proxy CONNECT closed before it was ready'));return false;}
    if(event==='close'){clearTimeout(this.timer);this.headers=Buffer.alloc(0);this.phase='closed';}
    return super.emit(event,...args);
  }
}
