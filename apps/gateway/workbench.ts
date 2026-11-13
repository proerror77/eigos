import express from 'express';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import type {Config} from '../../packages/core/config.js';
import {z} from 'zod';

const importMap='{"imports":{"three":"/workbench/vendor/three/build/three.module.js","three/addons/":"/workbench/vendor/three/examples/jsm/"}}';
export function mountWorkbench(app:express.Express,config:Config){
  const directory=fileURLToPath(new URL('../workbench/',import.meta.url));
  const require=createRequire(import.meta.url),three=join(dirname(require.resolve('three')),'..');
  const logins=new Map<string,{device:string;expires:number;interval:number;next:number;cookie:string}>();
  const cookie=(req:express.Request)=>req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('eigos_login='))?.slice(12);
  const deviceSchema=z.strictObject({device_code:z.string(),user_code:z.string(),verification_uri_complete:z.url(),expires_in:z.number(),interval:z.number().optional()}).passthrough();
  app.use('/workbench',(_req,res,next)=>{
    res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self' 'sha256-${createHash('sha256').update(importMap).digest('base64')}'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
    res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');next();
  });
  app.get('/workbench/config',(_req,res)=>res.json({development:config.EIGOS_AUTH_MODE==='development',deviceLogin:Boolean(config.OAUTH_WORKBENCH_CLIENT_ID&&config.OAUTH_ISSUER),scopes:'openid ontology:read ontology:write tasks:read tasks:write'}));
  app.post('/workbench/login/start',async(req,res)=>{
    if(!config.OAUTH_WORKBENCH_CLIENT_ID||!config.OAUTH_ISSUER){res.status(503).json({error:'Configure the workbench OAuth public client'});return;}
    const now=Date.now();for(const [id,session] of logins)if(session.expires<=now)logins.delete(id);
    if(logins.size>=100){res.status(429).json({error:'Too many pending logins'});return;}
    const response=await fetch(new URL('oauth/device/code',config.OAUTH_ISSUER),{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.OAUTH_WORKBENCH_CLIENT_ID,audience:config.OAUTH_AUDIENCE!,scope:'openid ontology:read ontology:write tasks:read tasks:write'}),signal:AbortSignal.timeout(15000)});
    if(!response.ok){res.status(502).json({error:'Login provider rejected this client configuration'});return;}
    const data=deviceSchema.parse(await response.json());
    if(new URL(data.verification_uri_complete).origin!==new URL(config.OAUTH_ISSUER).origin)throw new Error('Unexpected login provider URL');
    const id=randomUUID(),secret=randomUUID(),interval=Math.max(5,data.interval??5);
    logins.set(id,{device:data.device_code,expires:now+Math.min(data.expires_in,900)*1000,interval,next:now+interval*1000,cookie:secret});
    res.cookie('eigos_login',secret,{httpOnly:true,secure:config.PUBLIC_URL.startsWith('https:'),sameSite:'strict',path:'/workbench/login',maxAge:900000});
    res.json({id,userCode:data.user_code,url:data.verification_uri_complete,interval});
  });
  app.post('/workbench/login/poll',async(req,res)=>{
    const id=z.uuid().parse(req.body.id),session=logins.get(id);
    if(!session||session.expires<=Date.now()||session.cookie!==cookie(req)){res.status(403).json({error:'Login session expired'});return;}
    if(Date.now()<session.next){res.status(202).json({pending:true,interval:session.interval});return;}
    session.next=Date.now()+session.interval*1000;
    const response=await fetch(new URL('oauth/token',config.OAUTH_ISSUER!),{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.OAUTH_WORKBENCH_CLIENT_ID!,device_code:session.device,grant_type:'urn:ietf:params:oauth:grant-type:device_code'}),signal:AbortSignal.timeout(15000)});
    const data=await response.json() as {error?:string;access_token?:string;expires_in?:number};
    if(data.error==='authorization_pending'||data.error==='slow_down'){
      if(data.error==='slow_down')session.interval+=5;
      res.status(202).json({pending:true,interval:session.interval});return;
    }
    logins.delete(id);res.clearCookie('eigos_login',{path:'/workbench/login'});
    if(!response.ok||!data.access_token){res.status(403).json({error:'Login was declined or expired'});return;}
    res.setHeader('Cache-Control','no-store');res.json({accessToken:data.access_token,expiresIn:data.expires_in});
  });
  app.use('/workbench/vendor/three',express.static(three,{dotfiles:'deny',index:false}));
  app.use('/workbench',express.static(directory,{dotfiles:'deny',index:'index.html'}));
}
