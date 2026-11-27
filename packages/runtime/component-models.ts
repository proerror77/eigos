import { combineClassification } from '../ontology/classification.js';
import { sseData } from '../sdk/event-stream.js';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { Conflict, InvalidInput, PermissionDenied, ServiceUnavailable, digest } from '../core/identity.js';
import { ontologyName } from '../ontology/schema.js';
import type { Database } from './database.js';
import type { FunctionContext } from './functions.js';
import type { FunctionInvocationMetrics } from './function-invocations.js';
import { ModelEgress } from './model-egress.js';
import { ComponentSourceSecrets } from './component-source-secrets.js';

const destination = z.strictObject({
  provider: z.string().regex(/^[A-Za-z0-9_.:/-]{1,160}$/), model: z.string().regex(/^[A-Za-z0-9_.:/-]{1,160}$/),
  endpoint: z.url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search; }),
  secret: z.string().min(1).max(128), maxTokens: z.number().int().min(1).max(32768),
});
const registry = z.record(ontologyName,destination);
type Destination = z.output<typeof destination>;
const messages = z.array(z.strictObject({ role: z.enum(['system','user','assistant']), content: z.string().max(131072) })).min(1).max(100);
const usage = z.object({ prompt_tokens:z.number().int().nonnegative(), completion_tokens:z.number().int().nonnegative() });
const event = z.object({ choices:z.array(z.object({ delta:z.object({content:z.string().nullish()}).optional() })), usage:usage.nullish() });

export class ComponentModels {
  private readonly entries: Record<string,Destination>;
  constructor(private readonly db: Database, raw: unknown, private readonly secrets: Pick<ComponentSourceSecrets,'get'>,
    private readonly transport: typeof fetch = fetch) { this.entries=registry.parse(raw); }
  binding(aliases: readonly string[]) {
    return digest(aliases.map(alias=>[alias,this.destination(alias)]));
  }
  private destination(alias:string) {
    if (!Object.hasOwn(this.entries,alias)) throw new Conflict('Unknown component model alias');
    return this.entries[alias]!;
  }
  async *generate(alias:string, input:unknown, context:FunctionContext, signal:AbortSignal, metrics?:FunctionInvocationMetrics) {
    const config=this.destination(alias), access=context.objects.access;
    const body=messages.parse(input);
    const authorize=async()=>{
      await context.assertCurrent?.();
      await access.refresh(); signal.throwIfAborted();
      if (!await access.canDisclose(access.requirements())) throw new PermissionDenied('Model input permissions changed');
      const decision=await new ModelEgress(this.db,context.principal.owner,config.model,config.provider).decide(combineClassification(access.exportedClassification(),context.execution?.task.input.classification),true);
      if (!decision.allowed) throw new PermissionDenied('Model egress is not authorized');
    };
    await authorize();
    const credential=await this.secrets.get(config.secret);
    await authorize();
    let measurement=metrics?.modelUsage?.find(row=>row.alias===alias);
    if (metrics && !measurement) {
      measurement={alias,provider:config.provider,model:config.model,calls:0,reportedCalls:0,inputTokens:0,outputTokens:0};
      (metrics.modelUsage ??= []).push(measurement);
    }
    if (measurement) measurement.calls++;
    const response=await this.transport(config.endpoint,{method:'POST',redirect:'error',signal,
      headers:{authorization:'Bearer '+credential,'content-type':'application/json',accept:'text/event-stream'},
      body:JSON.stringify({model:config.model,messages:body,max_tokens:config.maxTokens,stream:true,stream_options:{include_usage:true}})});
    let recorded=false;
    for await (const data of sseData(response,4<<20)) {
      if (data==='[DONE]') return;
      const frame=event.parse(JSON.parse(data));
      if (frame.usage && !recorded) {
        recorded=true;
        if (measurement) {
          measurement.reportedCalls++;
          measurement.inputTokens+=frame.usage.prompt_tokens;
          measurement.outputTokens+=frame.usage.completion_tokens;
        }
      }
      const chunk=frame.choices[0]?.delta?.content;
      if (chunk) { await authorize(); yield chunk; }
    }
    throw new ServiceUnavailable('Incomplete model response');
  }
}

export function configuredComponentModels(db:Database, env=process.env) {
  const file=env.EIGOS_FUNCTION_MODELS_FILE;
  if (!file) return;
  const bundle=env.EIGOS_COMPONENT_SOURCE_SECRETS_FILE,key=env.EIGOS_COMPONENT_SOURCE_SECRETS_KEY_FILE;
  if (!bundle || !key) throw new Error('Component model aliases require encrypted credentials');
  return new ComponentModels(db,JSON.parse(readFileSync(file,'utf8')),new ComponentSourceSecrets(bundle,key));
}
