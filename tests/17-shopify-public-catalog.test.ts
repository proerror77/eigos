import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { configuredServices } from '../packages/capabilities/services/sources.js';
import { shopifyCatalogProfile, SHOPIFY_AGENT_PROFILE_PATH, SHOPIFY_CATALOG_ORIGIN } from '../packages/capabilities/shopify/read-only.js';
import { Objects } from '../packages/runtime/objects.js';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import { fixture, principal } from './fixture.js';

test('Shopify public Catalog negotiates the owner profile and preserves provider variant and seller identity through the Action', async () => {
  const directory = await mkdtemp(join(tmpdir(),'shopify-catalog-'));
  const path = join(directory,'sources.json');
  const binding = { provider:'Shopify', mode:'public_catalog', owner:principal.owner, bindingId:'global-catalog',
    active:true, expiresAt:new Date(Date.now()+600000).toISOString() };
  const config = (active:boolean) => writeFile(path,JSON.stringify([{...binding,active}]),{mode:0o600});
  await config(true);
  let calls=0;
  let revoke=false;
  const fetcher:typeof fetch = async(url,init)=>{
    calls++;
    assert.equal(url,SHOPIFY_CATALOG_ORIGIN+'/api/ucp/mcp');
    assert.equal(new Headers(init?.headers).has('Authorization'),false);
    assert.equal(new Headers(init?.headers).has('Shopify-Buyer-IP'),false);
    const body=JSON.parse(String(init?.body));
    assert.equal(body.method,'tools/call');
    assert.equal(body.params.name,'search_catalog');
    assert.equal(body.params.arguments.meta['ucp-agent'].profile,'https://eigos.example'+SHOPIFY_AGENT_PROFILE_PATH);
    assert.equal(body.params.arguments.catalog.context.address_country,'US');
    if(revoke)await config(false);
    return Response.json({jsonrpc:'2.0',id:body.id,result:{structuredContent:{
      ucp:{...shopifyCatalogProfile().ucp,status:'success'},products:[
        {id:'gid://shopify/p/PublicCotton',title:'Cotton sweater',variants:[
          {id:'gid://shopify/ProductVariant/1234',seller:{id:'gid://shopify/Shop/5678',name:'Fixture',domain:'fixture.myshopify.com'},
            price:{amount:1234,currency:'USD'},availability:{available:true}}
        ]}]}}});
  };
  const resolve=configuredServices(path,undefined,fetcher,{PUBLIC_URL:'https://eigos.example',EIGOS_AUTH_MODE:'jwt'});
  const f=await fixture(undefined,resolve);
  try {
    await assert.rejects(resolve('other-owner','Shopify'),/no owner connection/);
    const invalidHost=configuredServices(path,undefined,fetcher,{PUBLIC_URL:'http://127.0.0.1:3000',EIGOS_AUTH_MODE:'jwt'});
    await assert.rejects(invalidHost(principal.owner,'Shopify'),/HTTPS Gateway origin/);
    const overridden={...binding,agentProfile:'https://shopify.dev/ucp/agent-profiles/examples/2026-08-25/valid-with-capabilities.json'};
    await writeFile(path,JSON.stringify([overridden]),{mode:0o600});
    await assert.rejects(resolve(principal.owner,'Shopify'),/Private service configuration is unavailable/);
    await config(true);
    const input={query:'cotton sweater',country:'US',limit:1};
    const page=await f.capabilities.actions.apply(f.access,f.model,'SearchShopifyProducts',input,'public-search');
    const graph=new Objects(f.db,f.model,f.access);
    const read=await f.capabilities.functions.invoke(f.model,'readServiceSearch',{search:page},
      {principal,objects:graph,signal:AbortSignal.timeout(5000)}) as {items:unknown[];evidence:string};
    assert.equal(read.evidence,'provider_mock');assert.equal(read.items.length,1);
    const offer=(await graph.query({type:'ShopifyProductOffer'})).items[0]!.properties;
    assert.equal(offer.variantId,'gid://shopify/ProductVariant/1234');assert.equal(offer.amountMinor,1234);
    assert.equal(offer.merchantDomain,'fixture.myshopify.com');assert.equal(offer.deliveryTime,'unknown');
    assert.equal(calls,1);
    revoke=true;
    await assert.rejects(f.capabilities.actions.apply(f.access,f.model,'SearchShopifyProducts',input,'revoked-search'),/revoked|expired/);
    assert.equal((await graph.query({type:'ServiceSearchResult'})).items.length,1);
  } finally {await f.close();await rm(directory,{recursive:true,force:true});}
});

test('the public agent profile declares global catalog read capabilities',async()=>{
  const f=await fixture();
  const config=readConfig({DATABASE_URL:process.env.EIGOS_TEST_DATABASE_URL,EIGOS_AUTH_MODE:'development',EIGOS_DEV_TOKEN:'synthetic-shopify-profile-test'.repeat(2)});
  const server=createApp(config,f.db,f.source).app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  try{
    const address=server.address();assert(address&&typeof address!=='string');
    const response=await fetch('http://127.0.0.1:'+address.port+SHOPIFY_AGENT_PROFILE_PATH);
    assert.equal(response.status,200);
    const {ucp}=await response.json();
    assert.deepEqual(Object.keys(ucp.capabilities).sort(),['dev.shopify.catalog.global','dev.ucp.shopping.catalog.lookup','dev.ucp.shopping.catalog.search']);
    assert.equal(ucp.services['dev.ucp.shopping'][0].transport,'mcp');assert.deepEqual(ucp.payment_handlers,{});
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}
});
