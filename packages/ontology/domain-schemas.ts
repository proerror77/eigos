import { z } from 'zod';

// These are source/request data contracts, not default facts. Optional fields are
// deliberately not defaulted so historical inputs and their digests stay exact.
const text = z.string().trim().min(1).max(500);
const instant = z.iso.datetime({ offset: true });
const quantity = z.number().int().min(0).max(100);
const money = z.object({ minor: z.string().regex(/^(0|[1-9]\d{0,17})$/), currency: z.enum(['CNY', 'USD', 'EUR']) }).strict();

export const sourceLocationSchema = z.object({
  sourceId: text, placeId: text, address: text.optional(), meetingPoint: text.optional(),
  coordinates: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).strict().optional(),
}).strict();

export const cancellationTermsSchema = z.object({
  policyRef: text,
  kind: z.enum(['non_refundable', 'free_until', 'fee', 'unknown']),
  freeUntil: instant.optional(), fee: money.optional(), noShowFee: money.optional(),
}).strict().superRefine((value, context) => {
  if (value.kind === 'free_until' && !value.freeUntil) context.addIssue({ code: 'custom', path: ['freeUntil'], message: 'A free cancellation window needs its exact deadline' });
  if (value.kind === 'fee' && !value.fee) context.addIssue({ code: 'custom', path: ['fee'], message: 'A cancellation fee needs a scoped amount' });
  if (value.kind === 'non_refundable' && value.freeUntil) context.addIssue({ code: 'custom', path: ['freeUntil'], message: 'Non-refundable terms cannot also promise a free cancellation window' });
});
export const hotelOccupancySchema = z.object({ adults: z.number().int().min(1).max(100), childAges: z.array(z.number().int().min(0).max(17)).max(100) }).strict();
export const hotelBreakfastSchema = z.object({ included: z.boolean(), servingsPerRoom: quantity,
  frequency: z.enum(['daily', 'once_per_stay']).optional().describe('How often the per-room entitlement applies; absence does not imply daily breakfast'),
}).strict()
  .refine(value => value.included || value.servingsPerRoom === 0, 'Excluded breakfast cannot include servings');
export const hotelChildPolicySchema = z.object({ childrenAllowed: z.boolean(), maximumChildAge: z.number().int().min(0).max(17), maxChildrenPerRoom: quantity }).strict();
export const luggageCapacitySchema = z.object({ count: quantity, maximumSize: z.enum(['small', 'medium', 'large']) }).strict();
export const driverQualificationSchema = z.object({ age: z.number().int().min(16).max(100), licenseClass: text, licenseCountry: z.string().regex(/^[A-Z]{2}$/), licenseHeldMonths: z.number().int().min(0).max(1200) }).strict();
export const driverEligibilitySchema = z.object({
  minimumAge: z.number().int().min(16).max(100), maximumAge: z.number().int().min(16).max(100).optional(),
  licenseClasses: z.array(text).min(1).max(30), licenseCountries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(250),
  minimumLicenseHeldMonths: z.number().int().min(0).max(1200),
}).strict().refine(value => value.maximumAge === undefined || value.maximumAge >= value.minimumAge, 'Driver age range must be ordered');
const coverage = z.enum(['collision', 'theft', 'third_party', 'personal_accident']);
export const rentalInsuranceSchema = z.object({ policyRef: text, coverage: z.array(coverage).min(1).max(4), deductible: money }).strict()
  .refine(value => new Set(value.coverage).size === value.coverage.length, 'Insurance coverage must be unique');
export const rentalInsuranceRequirementSchema = z.object({ coverage: z.array(coverage).min(1).max(4), maximumDeductible: money }).strict()
  .refine(value => new Set(value.coverage).size === value.coverage.length, 'Requested insurance coverage must be unique');
export const menuSelectionSchema = z.object({ groupId: text, optionId: text }).strict();
export const menuSelectionsSchema = z.array(menuSelectionSchema).max(30)
  .refine(values => new Set(values.map(value => `${value.groupId}\u0000${value.optionId}`)).size === values.length, 'Menu selections must be unique');
export const menuOptionGroupSchema = z.object({ groupId: text, optionIds: z.array(text).min(1).max(30), minimumSelections: quantity, maximumSelections: quantity }).strict()
  .refine(value => value.maximumSelections >= value.minimumSelections && value.maximumSelections <= value.optionIds.length && new Set(value.optionIds).size === value.optionIds.length, 'Menu option bounds and identities must be consistent');
export const appointmentVisitSchema = z.enum(['first_visit', 'follow_up']);
export const appointmentCategorySchema = z.enum(['general', 'specialist']);
export const appointmentAdministrationSchema = z.object({
  visitTypes: z.array(appointmentVisitSchema).min(1).max(2), categories: z.array(appointmentCategorySchema).min(1).max(2),
  referralRequired: z.boolean(), minimumAge: z.number().int().min(0).max(120).optional(), maximumAge: z.number().int().min(0).max(120).optional(),
}).strict().refine(value => value.minimumAge === undefined || value.maximumAge === undefined || value.minimumAge <= value.maximumAge, 'Administrative age bounds must be ordered');
export const vehicleInspectionDetailsSchema = z.object({
  odometerKm: z.number().int().nonnegative(), fuelPercent: z.number().min(0).max(100),
  damage: z.array(z.object({ area: text, description: text }).strict()).max(100),
  agreement: z.enum(['accepted', 'disputed', 'pending', 'unknown']),
}).strict();
export const transportAssignmentSchema = z.object({
  providerReference: text, vehicleId: text, driverId: text.optional(), mode: z.enum(['instant', 'chauffeured', 'self_drive']),
  state: z.enum(['assigned', 'at_pickup', 'in_use', 'completed', 'released', 'canceled', 'unknown']),
  assignedAt: instant, atPickupAt: instant.optional(), boardedAt: instant.optional(), completedAt: instant.optional(),
}).strict().superRefine((value, context) => {
  if (value.mode !== 'self_drive' && !value.driverId) context.addIssue({ code: 'custom', path: ['driverId'], message: 'A sourced passenger-service assignment requires its driver identity' });
  const times = [value.assignedAt, value.atPickupAt, value.boardedAt, value.completedAt].filter((value): value is string => value !== undefined);
  if (times.some((time, index) => index > 0 && Date.parse(time) < Date.parse(times[index - 1]!))) context.addIssue({ code: 'custom', message: 'Assignment milestones must be chronological' });
});

/** Shared schema definitions appear inside the corresponding ontology property
 * and capability input schemas; this is not a second mutable schema registry. */
export const domainDataSchemas = {
  sourceLocation: sourceLocationSchema, cancellationTerms: cancellationTermsSchema,
  hotelOccupancy: hotelOccupancySchema, hotelBreakfast: hotelBreakfastSchema, hotelChildPolicy: hotelChildPolicySchema,
  luggageCapacity: luggageCapacitySchema, driverQualification: driverQualificationSchema, driverEligibility: driverEligibilitySchema,
  rentalInsurance: rentalInsuranceSchema, rentalInsuranceRequirement: rentalInsuranceRequirementSchema,
  menuSelections: menuSelectionsSchema, menuOptionGroup: menuOptionGroupSchema,
  appointmentAdministration: appointmentAdministrationSchema, vehicleInspectionDetails: vehicleInspectionDetailsSchema,
  transportAssignment: transportAssignmentSchema,
};
