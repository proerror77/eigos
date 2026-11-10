import { DomainError } from '../core/domain.js';
import { assertReviewedModel } from '../security/model-review.js';
import { projectionFields } from '../security/projections.js';
import { SecurityError } from '../security/errors.js';
import { currentKernelImplementation } from '../ontology/definition-store.js';
import { stagedKernelComponents } from '../ontology/seed-definition.js';
import { postgresTaskPointRows, postgresTaskReadOntology, withPostgresTaskReadGrant } from './task-read-access.js';
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
  const query = args.query;
  // The current task root needs no cursor or relationship scan. Historical
  // roots, filters, interface projections and derived fields use the general
  // reader with its complete graph and cursor semantics.
  const point = 'object' in query && query.object.type === 'ServiceRequest' && query.object.id === args.taskId
    && !query.as && !query.cursor && query.where.length === 0 ? query.object : undefined;
  const read=await withPostgresTaskReadAuthorization(client,p,args.taskId,policyDigest,async auth => {
    const rows = point && postgresTaskPointRows(client,p,args.taskId,policyDigest,point);
    if (point && rows?.direct && rows.body.rowCount === 1) {
      const admission = await withPostgresTaskReadGrant(client,p,args.taskId,policyDigest,async value=>value);
      if (!admission.grant.operations.includes('task.query')) throw new SecurityError('AUTHORIZATION_REQUIRED');
      if (args.expectedRequestRevision !== undefined && args.expectedRequestRevision !== admission.grant.requestRevision) throw new SecurityError('POLICY_CHANGED');
      const {model}=await postgresTaskReadOntology(client,p,args.taskId,policyDigest,builder);
      const current = builder === undefined ? currentKernelImplementation() : stagedKernelComponents(builder).model;
      assertReviewedModel(current,model);
      const definition=model.object(point.type), properties={...model.properties(point.type),...projectionFields(point.type)};
      if (rows.body.rows[0]?.definition_digest === model.fingerprint(point.type)
        && !query.select?.some(field=>'derived' in (properties[field]??{}))) {
        const keyFields=[...new Set([definition.primaryKey,definition.titleKey])];
        const anchor=await auth.readObject(point,keyFields);
        await auth.authorizeEvidence(anchor.envelope);
        if (anchor.object.properties[definition.primaryKey] !== point.id) throw new DomainError('CONFLICT','Invalid ontology object body');
        for (const field of query.select??[]) {
          if (!Object.hasOwn(properties,field)) throw new DomainError('INVALID_INPUT','Unknown selected property');
          if ('restricted' in properties[field]! && properties[field]!.restricted) throw new DomainError('FORBIDDEN','Restricted property cannot be selected');
        }
        const item=await auth.readView(point,point.type,query.select);
        await auth.authorizeEvidence(item.envelope);
        if (Buffer.byteLength(JSON.stringify(item.object))>60000) throw new DomainError('INVALID_INPUT','Object projection exceeds response limit');
        return {query:{items:[item.object],page:{limit:query.limit,hasMore:false,cursor:undefined}},requestRevision:admission.grant.requestRevision,cursorWrite:undefined};
      }
    }
    return postgresQueryAuthorizedObjects(client,p,args,policyDigest,auth,builder,{derive:(functionId,object,budget)=>
      postgresEvaluateAuthorizedFunction(client,p,args.taskId,args.expectedRequestRevision,{function:functionId,object},policyDigest,auth,builder,{budget,accessErrors:'throw'})});
  },builder,point);
  if(read.cursorWrite){
    const q=`"${postgresBusinessSchema(client)}"`,saved=read.cursorWrite;
    await client.query(`DELETE FROM ${q}.security_cursors WHERE expires_at<=$1`,[Date.now()]);
    await client.query(`INSERT INTO ${q}.security_cursors(id,context,expires_at,body) VALUES($1,$2,$3,$4)`,[saved.id,saved.context,saved.expiresAt,saved.body]);
  }
  return {version:2,taskId:args.taskId,requestRevision:read.requestRevision,
    items:read.query.items.map(({ref,revision,properties,derived})=>({ref,revision,properties,...(derived?{derived}:{})})),
    page:{limit:read.query.page.limit,hasMore:read.query.page.hasMore,cursor:read.query.page.cursor}};
}
