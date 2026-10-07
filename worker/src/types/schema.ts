import { z } from 'zod';
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}, 'Invalid calendar date');
const periods = { name: z.string().trim().min(1).max(200).optional(), policy_period_start: date.optional(), policy_period_end: date.optional() };
export const createAuditSchema = z.object(periods).refine(v => !v.policy_period_start || !v.policy_period_end || v.policy_period_start <= v.policy_period_end, 'Policy dates are reversed');
export const updateAuditSchema = z.object({
  ...periods,
  exposure_basis: z.literal('FULL_VENDOR_PAYMENTS').optional(),
  wc_rate_micros_per_100: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  assumptions_confirmed: z.boolean().optional()
}).refine(v => !v.policy_period_start || !v.policy_period_end || v.policy_period_start <= v.policy_period_end, 'Policy dates are reversed');
export const updateVendorSchema = z.object({ canonical_name: z.string().trim().min(1).max(200).optional(), exclude: z.boolean().optional() });
export const confirmMatchSchema = z.object({ coverage_record_id: z.string().uuid() });
