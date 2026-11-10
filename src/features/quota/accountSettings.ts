/**
 * The usage settings of an account row (⚙): its display name, scheduling
 * priority and weight, the renewal day (Claude and Codex), and,
 * for providers whose windows the gateway pools, the plan, plan multiplier,
 * legacy usage cap, lender and lender reserves. The draft is seeded from the
 * credential listing and saved diff-only: a field whose text is untouched is
 * never rewritten, so a gateway value the inputs would reject survives a save.
 * File management (prefix, proxy, headers, models) stays on Auth Files.
 */

import type { AuthFileFieldsPatch } from '@/services/api';
import type { AuthFileItem } from '@/types';
import {
  CLAUDE_PLAN_WEIGHTS,
  parsePlanMultiplierText,
  parsePriorityValue,
  parseReservePercentText,
  parseUsageCapPercentText,
  readAuthFilePlan,
  supportsAuthFileUsageCap,
} from '@/features/authFiles/constants';
import { parseCredentialWeightText, validateCredentialWeightText } from '@/utils/credentialWeight';

export interface AccountSettingsDraft {
  /** Display name; empty falls back to the email. */
  nickname: string;
  priority: string;
  weight: string;
  /** Day of the month (1-31) the plan renews; empty keeps the gateway's own date or estimate. */
  renewalDay: string;
  /** Claude only: '', 'pro', 'max' or 'ultra' (or a value the gateway reported as typed). */
  plan: string;
  planMultiplier: string;
  usageCap: string;
  lender: string;
  reserveFiveHour: string;
  reserveWeekly: string;
}

export type AccountSettingsError =
  | 'priority'
  | 'weight_integer'
  | 'weight_max'
  | 'plan_multiplier'
  | 'usage_cap'
  | 'reserve'
  | 'renewal_day';

type SettingsSource = Pick<
  AuthFileItem,
  | 'nickname'
  | 'priority'
  | 'weight'
  | 'renewalDay'
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
  nickname: file.nickname ?? '',
  priority: file.priority ? String(file.priority) : '',
  weight: text(file.weight),
  renewalDay: text(file.renewalDay),
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
  renewal: ['claude', 'codex'].includes(provider.trim().toLowerCase()),
});

/**
 * Whether the plan multiplier applies: a Claude plan the gateway weighs sets the
 * multiplier itself, so the field is only for other providers and a custom plan.
 */
export const showsPlanMultiplier = (provider: string, plan: string): boolean =>
  !accountSettingsFields(provider).plan || !(plan in CLAUDE_PLAN_WEIGHTS);

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

  if (changed('nickname')) patch.nickname = draft.nickname.trim() || null;

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

  if (fields.renewal && changed('renewalDay')) {
    const value = draft.renewalDay.trim();
    const day = /^\d{1,2}$/.test(value) ? Number(value) : NaN;
    if (value && !(day >= 1 && day <= 31)) return { error: 'renewal_day' };
    patch.renewal_day = value ? day : null;
  }

  if (!fields.pooled) return { patch };

  if (fields.plan && draft.plan !== seed.plan) patch.plan = draft.plan || null;

  if (changed('planMultiplier') && showsPlanMultiplier(provider, draft.plan)) {
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
