import type { Client } from 'pg';
import type { Principal } from '../core/domain.js';
import type { StagedKernelBuilder } from '../ontology/seed-definition.js';
import { secureQuerySchema } from '../security/view-contracts.js';
import { postgresBusinessSchema } from './runtime-transaction.js';
import { withPostgresTaskReadAuthorization } from './task-output.js';
import { postgresQueryAuthorizedObjects } from './ontology-read-query.js';
import { postgresEvaluateAuthorizedFunction } from './ontology-functions.js';

/** Public task query. Establish the complete task boundary and current input
 * visibility before applying data predicates or counting a page. Raw graph
 * storage is never exposed; every returned field passes the output boundary. */
export async function postgresQueryOntology(client: Client, principal: Principal, input: unknown,
  policyDigest: string, builder?: StagedKernelBuilder) {
  const p=structuredClone(principal),args=secureQuerySchema.parse(input);
  const read=await withPostgresTaskReadAuthorization(client,p,args.taskId,policyDigest,
    auth=>postgresQueryAuthorizedObjects(client,p,args,policyDigest,auth,builder,{derive:(functionId,object,budget)=>
      postgresEvaluateAuthorizedFunction(client,p,args.taskId,args.expectedRequestRevision,{function:functionId,object},policyDigest,auth,builder,{budget,accessErrors:'throw'})}),builder);
  if(read.cursorWrite){
    const q=`"${postgresBusinessSchema(client)}"`,saved=read.cursorWrite;
    await client.query(`DELETE FROM ${q}.security_cursors WHERE expires_at<=$1`,[Date.now()]);
    await client.query(`INSERT INTO ${q}.security_cursors(id,context,expires_at,body) VALUES($1,$2,$3,$4)`,[saved.id,saved.context,saved.expiresAt,saved.body]);
  }
  return {version:2,taskId:args.taskId,requestRevision:read.requestRevision,
    items:read.query.items.map(({ref,revision,properties,derived})=>({ref,revision,properties,...(derived?{derived}:{})})),
    page:{limit:read.query.page.limit,hasMore:read.query.page.hasMore,cursor:read.query.page.cursor}};
}
