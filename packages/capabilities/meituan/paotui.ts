import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { Conflict, digest } from '../../core/identity.js';
import { paotuiAddresses, paotuiInput, paotuiQuote } from '../../ontology/delivery.js';
import type { FunctionHandler } from '../../runtime/functions.js';
import { readPrivateSourceFile, yuanToFen } from '../../core/private-source.js';

const exec = promisify(execFile);
const clientId = 'ac76c22d257c4c6d9164719eea64ed4b';
const connection = z.strictObject({
  owner: z.string().min(1), active: z.boolean(), skillDirectory: z.string().refine(isAbsolute),
  passportExecutable: z.string().refine(isAbsolute),
});
const address = z.object({
  addressId: z.union([z.string().regex(/^[1-9][0-9]{0,20}$/), z.number().int().positive().safe()]),
  address: z.string().min(1).max(300), houseNumber: z.string().max(200).nullish(),
  name: z.string().max(100).nullish(), cityId: z.coerce.number().int().positive(),
  lat: z.number().int().min(-90000000).max(90000000), lng: z.number().int().min(-180000000).max(180000000),
});
const bookSchema = z.object({ addresses: z.array(address).max(100) });
const contactSchema = z.object({ phone: z.string().regex(/^1\d{10}$/) });
const previewSchema = z.object({
  _previewTotal: z.union([z.number(), z.string()]), _deliveryFee: z.union([z.number(), z.string()]),
  estimateTime: z.string().min(1).max(150), distance: z.string().min(1).max(40).nullish(),
});
// These are the official CLI's only operations used by this connection.
type ReadOperation = 'get_address_list' | 'get_address_info' | 'delivery_preview';

async function withPaotui<T>(filepath: string | undefined, owner: string, signal: AbortSignal,
  read: (call: (operation: ReadOperation, args?: string[]) => Promise<unknown>) => Promise<T>) {
  if (!filepath) throw new Conflict('Meituan Paotui requires the owner’s local account connection');
  const readConnection = async () => connection.parse(JSON.parse(await readPrivateSourceFile(filepath)));
  const config = await readConnection(), fingerprint = digest(config);
  if (!config.active || config.owner !== owner) throw new Conflict('Meituan Paotui connection is unavailable for this owner');
  const assertCurrent = async () => {
    signal.throwIfAborted();
    if (digest(await readConnection()) !== fingerprint) throw new Conflict('Meituan Paotui connection changed');
  };
  let token: string;
  try {
    const { stdout } = await exec(config.passportExecutable, ['get-token', '--client_id', clientId], {
      signal, timeout: 10000, maxBuffer: 65536,
    });
    token = z.string().regex(/^\S{16,8192}$/).parse(stdout.trim().split('\n').at(-1));
  } catch {
    signal.throwIfAborted();
    throw new Conflict('Meituan Paotui account authorization is unavailable');
  }
  const directory = await mkdtemp(join(tmpdir(), 'eigos-paotui-'));
  try {
    await Promise.all(['paotui.js', 'config.json'].map(name => copyFile(join(config.skillDirectory, name), join(directory, name))));
    const result = await read(async (operation, args = []) => {
      await assertCurrent();
      try {
        const { stdout } = await exec(process.execPath, [join(directory, 'paotui.js'), operation, ...args], {
          cwd: directory, signal, timeout: 18000, maxBuffer: 512000,
          env: { PATH: process.env.PATH, HOME: directory, MCP_ACCESS_TOKEN: token },
        });
        return z.object({ status: z.literal('ok') }).passthrough().parse(JSON.parse(stdout));
      } catch {
        signal.throwIfAborted();
        throw new Conflict(`Meituan Paotui did not return a valid result for ${operation}`);
      }
    });
    await assertCurrent();
    return result;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Conflict) throw error;
    throw new Conflict('Meituan Paotui connection or returned data is unavailable');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function paotuiFunctions(filepath?: string): ReadonlyMap<string, FunctionHandler> {
  return new Map<string, FunctionHandler>([
    ['listMeituanPaotuiAddresses', async (_raw, context) => withPaotui(filepath, context.principal.owner, context.signal, async call => {
      const { addresses } = bookSchema.parse(await call('get_address_list'));
      return paotuiAddresses.parse(addresses.map(a => ({ addressId: String(a.addressId), label: a.address })));
    })],
    ['quoteMeituanPaotui', async (raw, context) => {
      const { senderAddressId, recipientAddressId, ...goods } = paotuiInput.parse(raw);
      if (senderAddressId === recipientAddressId) throw new Conflict('Select two different saved addresses');
      return withPaotui(filepath, context.principal.owner, context.signal, async call => {
        const { addresses } = bookSchema.parse(await call('get_address_list'));
        const saved = (id: string) => {
          const matches = addresses.filter(a => String(a.addressId) === id);
          if (matches.length !== 1) throw new Conflict('Select an address in the owner’s current Meituan address book');
          return matches[0]!;
        };
        const left = saved(senderAddressId), right = saved(recipientAddressId);
        if (left.cityId !== right.cityId) throw new Conflict('Meituan Paotui preview requires two addresses in the same city');
        const withPhone = async ({ addressId, ...location }: z.infer<typeof address>) => {
          const result = await call('get_address_info', ['--address-id', String(addressId)]);
          const contact = contactSchema.parse(result);
          return { ...location, phone: contact.phone };
        };
        const [sender, recipient] = await Promise.all([withPhone(left), withPhone(right)]);
        const categories = { 文件: 4, 快递: 8, 餐饮: 2 };
        const quote = previewSchema.parse(await call('delivery_preview', [
          '--sender', JSON.stringify(sender), '--recipient', JSON.stringify(recipient),
          '--goods', JSON.stringify({ goodsName: goods.goodsName, goodsWeight: goods.weightKg,
            goodTypes: [categories[goods.category]], goodTypeNames: [goods.category] }),
          '--business-type', '1', '--service-type', goods.service === 'ordinary' ? '1003' : '4033',
        ]));
        return paotuiQuote.parse({ provider: 'MeituanPaotui', feeMinor: yuanToFen(quote._previewTotal),
          originalFeeMinor: yuanToFen(quote._deliveryFee), currency: 'CNY', estimatedDelivery: quote.estimateTime,
          ...(quote.distance ? { distance: quote.distance } : {}), goods, evidence: 'live_readonly',
          observedAt: new Date().toISOString() });
      });
    }],
  ]);
}
