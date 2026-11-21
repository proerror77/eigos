import { z } from 'zod';
import { Conflict } from '../../core/identity.js';

// Jinghang search (API 61643) returns these conditions on each fare, for validation before airbook.
const bound = z.number().int().nonnegative().safe().nullish();
const range = z.strictObject({ min_num: bound, max_num: bound })
  .refine(({ min_num, max_num }) => min_num == null || max_num == null || min_num <= max_num);
const restrictions = z.strictObject({
  age_range_list: z.strictObject({ pair_num_range: z.array(range) }).nullish(),
  person_num_range: range.nullish(),
  regions: z.string().nullish(),
  member_restrict: z.record(z.string(), z.unknown()).nullish(),
  supported_cert_type_map: z.string().nullish(),
});
const credentialMap = z.record(z.string(), z.array(z.number().int().nonnegative()));

function contains(limits: z.infer<typeof range>, value: number) {
  return (limits.min_num == null || limits.min_num <= value) && (limits.max_num == null || value <= limits.max_num);
}

export function requireEligiblePassenger(raw: unknown, passenger: { birthday: string; credential_type: number }, departure: string) {
  if (raw == null) return;
  const decoded = restrictions.safeParse(raw);
  if (!decoded.success) throw new Conflict('The selected Jinghang fare has unsupported passenger restrictions');
  const rule = decoded.data;
  const years = Number(departure.slice(0, 4)) - Number(passenger.birthday.slice(0, 4)) -
    Number(departure.slice(5) < passenger.birthday.slice(5));
  const ages = rule.age_range_list?.pair_num_range;
  if (ages?.length && !ages.some(limits => contains(limits, years)))
    throw new Conflict('The passenger does not meet the Jinghang fare age requirements');
  if (rule.person_num_range && !contains(rule.person_num_range, 1))
    throw new Conflict('The Jinghang fare does not allow a single adult passenger');
  if (rule.member_restrict && Object.keys(rule.member_restrict).length)
    throw new Conflict('The Jinghang fare requires membership eligibility that this booking cannot verify');
  // The public reference names the ID prefixes but does not establish allow/deny semantics.
  if (rule.regions) throw new Conflict('Regional eligibility for this Jinghang fare cannot be verified');
  if (rule.supported_cert_type_map != null) {
    let certificates: unknown;
    try { certificates = JSON.parse(rule.supported_cert_type_map); } catch {
      throw new Conflict('The Jinghang fare credential requirements are malformed');
    }
    const map = credentialMap.safeParse(certificates);
    if (!map.success || !map.data['0']?.includes(passenger.credential_type))
      throw new Conflict('The adult passenger credential is not eligible for the Jinghang fare');
  }
}
