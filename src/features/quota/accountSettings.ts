/**
 * The usage settings of an account row (⚙): scheduling priority and weight, and,
 * for providers whose windows the gateway pools, the plan, plan multiplier,
 * legacy usage cap, lender and lender reserves. The draft is seeded from the
 * credential listing and saved diff-only: a field whose text is untouched is
 * never rewritten, so a gateway value the inputs would reject survives a save.
 * File management (prefix, proxy, headers, models) stays on Auth Files.
 */

import type { AuthFileFieldsPatch } from '@/services/api';
import type { AuthFileItem } from '@/types';
import {
  parsePlanMultiplierText,
  parsePriorityValue,
  parseReservePercentText,
  parseUsageCapPercentText,
  readAuthFilePlan,
  supportsAuthFileUsageCap,
} from '@/features/authFiles/constants';
import { parseCredentialWeightText, validateCredentialWeightText } from '@/utils/credentialWeight';

export interface AccountSettingsDraft {
  priority: string;
  weight: string;
  /** Claude only: '', 'pro', 'max' or 'ultra' (or a value the gateway reported as typed). */
  plan: string;
  planMultiplier: string;
  usageCap: string;
  lender: string;
  reserveFiveHour: string;
  reserveWeekly: string;
}

export type AccountSettingsError =
  'priority' | 'weight_integer' | 'weight_max' | 'plan_multiplier' | 'usage_cap' | 'reserve';

type SettingsSource = Pick<
  AuthFileItem,
  | 'priority'
  | 'weight'
  | 'plan'
  | 'planMultiplier'
  | 'usageCapPercent'
  | 'lender'
  | 'reserveFiveHourPercent'
  | 'reserveWeeklyPercent'
>;

const text = (value: number | string | undefined) => (value === undefined ? '' : String(value));

/**
 * The listing's values as text. Priority 0 is the default and reads as empty.
 * The listed reserves are the ones the gateway applies, so a reserve implied by
 * the usage cap shows too; saving leaves it alone unless it is edited.
 */
export const accountSettingsDraft = (file: SettingsSource): AccountSettingsDraft => ({
  priority: file.priority ? String(file.priority) : '',
  weight: text(file.weight),
  plan: readAuthFilePlan({ plan: file.plan }),
  planMultiplier: text(file.planMultiplier),
  usageCap: text(file.usageCapPercent),
  lender: file.lender ?? '',
  reserveFiveHour: text(file.reserveFiveHourPercent),
  reserveWeekly: text(file.reserveWeeklyPercent),
});

/** Which fields the row offers for a provider. */
export const accountSettingsFields = (provider: string) => ({
  pooled: supportsAuthFileUsageCap(provider),
  plan: provider.trim().toLowerCase() === 'claude',
});

export type AccountSettingsResult =
  { patch: AuthFileFieldsPatch; error?: never } | { error: AccountSettingsError; patch?: never };

/** The fields that changed against `seed`, validated as the Auth Files editor does. */
export function buildAccountSettingsPatch(
  provider: string,
  seed: AccountSettingsDraft,
  draft: AccountSettingsDraft
): AccountSettingsResult {
  const patch: AuthFileFieldsPatch = {};
  const changed = (key: keyof AccountSettingsDraft) => draft[key].trim() !== seed[key].trim();

  if (changed('priority')) {
    const value = draft.priority.trim();
    // The gateway treats 0 as the default and the editor clears with it.
    const next = value ? parsePriorityValue(value) : 0;
    if (next === undefined) return { error: 'priority' };
    patch.priority = next;
  }

  if (changed('weight')) {
    const invalid = validateCredentialWeightText(draft.weight);
    if (invalid) return { error: invalid === 'max' ? 'weight_max' : 'weight_integer' };
    patch.weight = parseCredentialWeightText(draft.weight) ?? null;
  }

  const fields = accountSettingsFields(provider);
  if (!fields.pooled) return { patch };

  if (fields.plan && draft.plan !== seed.plan) patch.plan = draft.plan || null;

  if (changed('planMultiplier')) {
    const next = parsePlanMultiplierText(draft.planMultiplier);
    if (next === undefined) return { error: 'plan_multiplier' };
    patch.plan_multiplier = next;
  }

  if (changed('usageCap')) {
    const next = parseUsageCapPercentText(draft.usageCap);
    if (next === undefined) return { error: 'usage_cap' };
    patch.usage_cap_percent = next;
  }

  if (changed('lender')) patch.lender = draft.lender.trim() || null;

  for (const [key, field] of [
    ['reserveFiveHour', 'reserve_five_hour_percent'],
    ['reserveWeekly', 'reserve_weekly_percent'],
  ] as const) {
    if (!changed(key)) continue;
    const next = parseReservePercentText(draft[key]);
    if (next === undefined) return { error: 'reserve' };
    patch[field] = next;
  }

  return { patch };
}
