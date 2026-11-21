import { apiClient } from './client';
import { isRecord } from '@/utils/helpers';

/**
 * Upstream input keys: the API-key credentials the gateway spends (Claude, Gemini, OpenAI-compatible
 * and so on), read from `GET /credentials` with their client-key scope, credential groups and
 * monthly spend limit. Settings are written through `PATCH /api-keys/settings`.
 */

export interface InputKey {
  /** Auth id, e.g. `claude:apikey:0123456789ab`. */
  id: string;
  /** Configured group or entry name; empty when unnamed. */
  name: string;
  provider: string;
  disabled: boolean;
  serveClientKeys: boolean;
  clientKeysOnly: boolean;
  credentialGroups: string[];
  /** Day of the month the spend cycle starts, 1–31. */
  billingCycleDay: number;
  /** 0 means unlimited. */
  monthlyLimitUsd: number;
  cycleStartMs: number | null;
  /** Priced spend in the current cycle; null while the usage ledger is off. */
  spentUsdCycle: number | null;
  unpricedUsageCycle: boolean;
  limitReached: boolean;
}

export interface InputKeySettings {
  authId: string;
  billingCycleDay: number;
  monthlyLimitUsd: number;
  clientKeysOnly: boolean;
  serveClientKeys: boolean;
  credentialGroups: string[];
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** API-key credentials only; OAuth subscriptions and files are listed elsewhere. */
export const isInputKeyEntry = (raw: Record<string, unknown>): boolean =>
  raw.auth_kind === 'api-key' ||
  str(raw.source).startsWith('config:') ||
  raw.serve_client_keys !== undefined ||
  raw.client_keys_only !== undefined;

export const normalizeInputKey = (raw: Record<string, unknown>): InputKey => {
  const day = num(raw.billing_cycle_day);
  const cycleStart = Date.parse(str(raw.cycle_start));
  const clientKeysOnly = raw.client_keys_only === true;
  return {
    id: str(raw.id),
    name: str(raw.name),
    provider: str(raw.provider) || str(raw.type),
    disabled: raw.disabled === true,
    // client-keys-only implies serving client keys.
    serveClientKeys: clientKeysOnly || raw.serve_client_keys === true,
    clientKeysOnly,
    credentialGroups: Array.isArray(raw.credential_groups)
      ? raw.credential_groups.map(str).filter(Boolean)
      : [],
    billingCycleDay: day !== null && day >= 1 && day <= 31 ? Math.trunc(day) : 1,
    monthlyLimitUsd: Math.max(0, num(raw.monthly_limit_usd) ?? 0),
    cycleStartMs: Number.isFinite(cycleStart) ? cycleStart : null,
    spentUsdCycle: num(raw.spent_usd_cycle),
    unpricedUsageCycle: raw.unpriced_usage_cycle === true,
    limitReached: raw.limit_reached === true,
  };
};

export const serializeInputKeySettings = (input: InputKeySettings) => ({
  auth_id: input.authId,
  billing_cycle_day: input.billingCycleDay,
  monthly_limit_usd: input.monthlyLimitUsd,
  client_keys_only: input.clientKeysOnly,
  serve_client_keys: input.clientKeysOnly || input.serveClientKeys,
  credential_groups: input.credentialGroups,
});

export const inputKeysApi = {
  async list(): Promise<InputKey[]> {
    const data = await apiClient.get<unknown>('/credentials');
    const files = isRecord(data) && Array.isArray(data.files) ? data.files.filter(isRecord) : [];
    return files.filter(isInputKeyEntry).map(normalizeInputKey);
  },

  updateSettings: (input: InputKeySettings) =>
    apiClient.patch<unknown>('/api-keys/settings', serializeInputKeySettings(input)),
};
