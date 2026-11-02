import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fliggyInputSchema, parseFliggyResponse, validateFliggyInput } from '../packages/capabilities/fliggy/contracts.js';
import { FLIGGY_CLI_GUARD } from '../packages/capabilities/fliggy/cli-guard.js';
import { FliggyConnector } from '../packages/capabilities/fliggy/connector.js';
import { packageInput,packageResponse,hotelInput,hotelResponse,flightInput,flightResponse } from './fixtures/fliggy.js';
import { parseMcpReadModule, resolveOntologyMcpRead } from '../packages/ontology/mcp-read.js';
import { fliggyDefinition } from '../packages/ontology/fliggy.js';

for(const [name,input,raw] of [['flight',flightInput,flightResponse],['hotel',hotelInput,hotelResponse],['package',packageInput,packageResponse]] as const)
  test(`${name} preserves source observations and partial/unknown price terms`,()=>{
    const result=parseFliggyResponse(input,raw);
    assert.equal(result.items.length,1);assert.equal(result.accessLevel,'trial');assert.equal(result.completeness,'partial');
    assert.ok(!JSON.stringify(result).includes('commissionRate'));
  });
test('masked/from prices, opaque rate and absent commission cannot become a numeric total or zero rebate',()=>{
  const hotel=parseFliggyResponse(hotelInput,hotelResponse).items[0]!;
  assert(hotel.kind==='hotel');assert.equal(hotel.offer.price,'¥4xx');assert.equal(hotel.offer.commissionMoneyYuan,null);assert.equal(hotel.offer.rate,null);
  const product=parseFliggyResponse(packageInput,packageResponse).items[0]!;assert(product.kind==='marriottPackage');assert.equal(product.offer.price,'￥499起/1晚');
});
test('only explicit empty responses complete with no results',()=>{
  assert.equal(parseFliggyResponse(packageInput,{status:0,message:'empty',data:null}).resultState,'empty');
  for(const raw of [{status:401,message:'unauthorized',data:null},{status:0,message:'success',data:null},{status:0,message:'success',data:{}},{status:0,message:'empty',data:packageResponse.data}])assert.throws(()=>parseFliggyResponse(packageInput,raw));
});
test('source hyperlinks, IDs and departure date are validated without trusting prose',()=>{
  const wrong=structuredClone(flightResponse);wrong.data.itemList[0]!.journeys[0]!.segments[0]!.depDateTime='2099-02-01 08:00:00';assert.throws(()=>parseFliggyResponse(flightInput,wrong));
  const url=structuredClone(packageResponse);url.data.itemList[0]!.detailUrl='https://evil.invalid/payment';assert.throws(()=>parseFliggyResponse(packageInput,url));
  const hotel={...hotelResponse,data:{itemList:[{...hotelResponse.data.itemList[0],shid:'other-hotel'}]}};assert.throws(()=>parseFliggyResponse(hotelInput,hotel));
});
test('input does not accept unsupported private passenger data, ignored CLI filters or contradictory dates',()=>{
  assert.equal(fliggyInputSchema.safeParse({...flightInput,criteria:{...flightInput.criteria,passengerPhone:'not-a-supported-field'}}).success,false);
  assert.equal(fliggyInputSchema.safeParse({kind:'marriottHotel',criteria:{...hotelInput.criteria,hotelBrands:'ignored by pinned CLI'}}).success,false);
  for(const value of [{...flightInput,criteria:{...flightInput.criteria,depDate:'2020-01-01'}},{...hotelInput,criteria:{...hotelInput.criteria,checkOutDate:'2098-01-01'}},{kind:'marriottPackage',criteria:{}}])assert.throws(()=>validateFliggyInput(fliggyInputSchema.parse(value)));
});
test('MCP root argument object preserves optional filters and refuses ambiguous or oversized mappings',()=>{
  const binding=fliggyDefinition.actions[0]!.mcp;
  const result=resolveOntologyMcpRead(binding,{}, {criteria:{origin:'北京',destination:'上海',depDate:'2099-01-01',sortType:3,limit:10}},()=>assert.fail('No dependencies'));
  assert.deepEqual(result.args,{origin:'北京',destination:'上海',depDate:'2099-01-01',sortType:3,limit:10});
  const changed=structuredClone(fliggyDefinition);changed.actions[0]!.mcp.arguments={injected:{from:'literal',value:'unexpected'}};assert.throws(()=>parseMcpReadModule(changed));
  assert.throws(()=>resolveOntologyMcpRead(binding,{}, {criteria:Array(40).fill('bad')},()=>{}));
  assert.throws(()=>resolveOntologyMcpRead(binding,{}, {criteria:Object.fromEntries(Array.from({length:33},(_,i)=>['field'+i,i]))},()=>{}));
});

function guardedRead(change:{tool?:string;target?:string;status?:number;key?:string;repeat?:boolean;oversize?:boolean}={}) {
  const dir=mkdtempSync(join(tmpdir(),'fliggy-guard-test-'));
  try {
    const cli=join(dir,'source.cjs'),guard=join(dir,'guard.cjs'),network=join(dir,'network.cjs'),policy=join(dir,'policy.json');
    writeFileSync(network,`global.calls=0;globalThis.fetch=async()=>{global.calls++;return new Response(${change.oversize?"'x'.repeat(1048577)":"'{}'"},{status:${change.status??200}})};`);
    writeFileSync(cli,`(async()=>{try{const path=require('node:path'),os=require('node:os'),fs=require('node:fs');if(fs.existsSync(path.join(os.homedir(),'.flyai','config.json')))throw Error('Implicit account visible');const init={method:'POST',headers:{authorization:${JSON.stringify('Bearer '+(change.key??'synthetic-key'))}},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:${JSON.stringify(change.tool??'search_hotels')},arguments:{destName:'Synthetic city',limit:10}}})};const r=await fetch(${JSON.stringify(change.target??'https://flyai.open.fliggy.com/mcp')},init);await r.text();${change.repeat?'await fetch(\'https://flyai.open.fliggy.com/mcp\',init);':''}console.log(JSON.stringify({status:'ok',calls:global.calls}));}catch(e){console.log(JSON.stringify({status:'rejected',calls:global.calls}));}})();`);
    writeFileSync(guard,FLIGGY_CLI_GUARD);
    writeFileSync(policy,JSON.stringify({cli,cliSha256:createHash('sha256').update(readFileSync(cli)).digest('hex'),tool:'search_hotels',args:{destName:'Synthetic city',limit:10},keySha256:createHash('sha256').update('synthetic-key').digest('hex')}));
    return JSON.parse(execFileSync(process.execPath,['--require',network,'--require',guard,cli],{encoding:'utf8',env:{PATH:process.env.PATH??'',EIGOS_FLIGGY_POLICY_FILE:policy},timeout:10000}));
  }finally{rmSync(dir,{recursive:true,force:true});}
}
test('child CLI guard permits only the exact source/account/tool/criteria once and bounds response size',()=>{
  assert.deepEqual(guardedRead(),{status:'ok',calls:1});
  for(const value of [{tool:'create_order'},{target:'https://evil.invalid/mcp'},{key:'unrelated-account'}])assert.deepEqual(guardedRead(value),{status:'rejected',calls:0});
  for(const value of [{status:302},{repeat:true},{oversize:true}])assert.deepEqual(guardedRead(value),{status:'rejected',calls:1});
});
test('key mode refuses missing credentials before invoking the provider',async()=>{
  await assert.rejects(new FliggyConnector({mode:'key',keyFile:'/no/such/private/fliggy-key',keySha256:'a'.repeat(64)}).search(packageInput,new AbortController().signal),/Fliggy search failed/);
});
