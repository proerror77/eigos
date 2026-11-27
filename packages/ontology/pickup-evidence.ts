import { z } from 'zod';

export const placeDetailInput = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });
export const pickupCoordinateEvidence = z.strictObject({
  provider: z.literal('Amap'), fetchedAt: z.iso.datetime({ offset: true }),
  inputCoordinateSystem: z.enum(['wgs84', 'gcj02']), coordinateSystem: z.literal('gcj02'),
  conversion: z.enum(['converted_by_amap', 'already_gcj02']),
});
