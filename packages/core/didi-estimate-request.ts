import {z} from 'zod';

const place=z.string().trim().min(1).max(500);
export const didiEstimateRouteSchema=z.strictObject({city:z.string().trim().min(1).max(100),origin:place,destination:place,serviceClass:place.optional()});
export const didiEstimateRequestSchema=z.discriminatedUnion('mode',[
  didiEstimateRouteSchema.extend({mode:z.literal('structured')}),
  z.strictObject({mode:z.literal('natural')}),
]);
export const didiEstimateDecisionSchema=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('estimate'),route:didiEstimateRouteSchema}),
  z.strictObject({kind:z.enum(['clarify','unsupported']),message:z.string().trim().min(1).max(500)}),
]);
export type DidiEstimateRequest=z.infer<typeof didiEstimateRequestSchema>;
export type DidiEstimateDecision=z.infer<typeof didiEstimateDecisionSchema>;
export const didiEstimateGoal='只查询滴滴估价，不叫车、不下单、不付款。';
export function structuredDidiGoal(input:Extract<DidiEstimateRequest,{mode:'structured'}>){
  const {mode:_mode,...route}=input;
  return didiEstimateGoal+JSON.stringify(route);
}
