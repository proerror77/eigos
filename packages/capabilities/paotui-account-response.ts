import { z } from 'zod';

const identifier = z.union([z.string().regex(/^[1-9]\d{0,19}$/), z.number().int().positive().safe()]).transform(String);
export const paotuiAccountResponseSchema = z.strictObject({ accountId: identifier, addressIds: z.array(z.string().min(1).max(128)).min(1).max(100) });
export type PaotuiAccountResponse = z.infer<typeof paotuiAccountResponseSchema>;

/** The authenticated owned-address response supplies an explicit userId. Neither
 * matching addresses nor a cached/decoded token is an account identity proof. */
export function paotuiAccountResponse(value: unknown): PaotuiAccountResponse | undefined {
  try {
    const outer = z.object({ code: z.literal(0), data: z.string().max(512000) }).parse(value);
    const inner = z.object({ code: z.literal(0), data: z.object({ userAddresses: z.array(z.object({ id: identifier, userId: identifier })).min(1).max(100) }) }).parse(JSON.parse(outer.data));
    const rows = inner.data.userAddresses;
    if (new Set(rows.map(row => row.userId)).size !== 1 || new Set(rows.map(row => row.id)).size !== rows.length) return undefined;
    return { accountId: rows[0]!.userId, addressIds: rows.map(row => row.id) };
  } catch { return undefined; }
}
