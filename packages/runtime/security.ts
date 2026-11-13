import { z } from 'zod';
import { digest } from '../core/identity.js';
import type { Database } from './database.js';

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const condition = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('equals'), property: z.string().min(1), value: scalar }),
  z.strictObject({ op: z.literal('subject'), property: z.string().min(1) }),
  z.strictObject({ op: z.literal('member'), property: z.string().min(1) }),
]);
export const expressionSchema = z.strictObject({ all: z.array(condition).max(20).default([]), any: z.array(condition).max(20).default([]) });
export const objectPolicySchema = z.strictObject({
  read: expressionSchema.optional(),
  properties: z.record(z.string(), expressionSchema).default({}),
  markingsProperty: z.string().optional(),
});
export type ObjectPolicy = z.infer<typeof objectPolicySchema>;
type Expression = z.infer<typeof expressionSchema>;
export type SecurityContext = { subject: string; groups: string[]; markings: string[] };

export async function initializeSecurity(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.security_memberships (
    subject text NOT NULL, kind text NOT NULL CHECK(kind IN ('group','marking')), name text NOT NULL, PRIMARY KEY(subject,kind,name));
    CREATE TABLE IF NOT EXISTS ${db.schema}.object_policies (
    ontology text NOT NULL, type text NOT NULL, policy jsonb NOT NULL, PRIMARY KEY(ontology,type));`);
}
export function permits(expression: Expression | undefined, properties: Record<string, unknown>, context: SecurityContext): boolean {
  if (!expression) return true;
  const check = (item: z.infer<typeof condition>) => {
    const value = properties[item.property];
    if (item.op === 'equals') return digest(value ?? null) === digest(item.value);
    if (item.op === 'subject') return value === context.subject;
    return (Array.isArray(value) ? value : [value]).some(group => typeof group === 'string' && context.groups.includes(group));
  };
  return expression.all.every(check) && (!expression.any.length || expression.any.some(check));
}
export function markingsOf(policy: ObjectPolicy | undefined, properties: Record<string, unknown>): string[] {
  if (!policy?.markingsProperty) return [];
  return z.array(z.string()).parse(properties[policy.markingsProperty] ?? []);
}
export function policySql(expression: Expression | undefined, values: unknown[], context: SecurityContext, column = 'properties'): string {
  if (!expression) return 'TRUE';
  const bind = (value: unknown) => { values.push(value); return '$' + values.length; };
  const check = (item: z.infer<typeof condition>) => {
    const field = `${column}->${bind(item.property)}::text`;
    if (item.op === 'equals') return `COALESCE(${field},'null'::jsonb)=${bind(JSON.stringify(item.value))}::jsonb`;
    if (item.op === 'subject') return `${field}=${bind(JSON.stringify(context.subject))}::jsonb`;
    return `EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${field})='array' THEN ${field} ELSE jsonb_build_array(${field}) END) g WHERE jsonb_typeof(g)='string' AND g#>>'{}'=ANY(${bind(context.groups)}::text[]))`;
  };
  const all = expression.all.map(check), any = expression.any.map(check);
  return [...all, ...(any.length ? ['(' + any.join(' OR ') + ')'] : [])].join(' AND ') || 'TRUE';
}
