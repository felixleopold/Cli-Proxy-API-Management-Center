import { apiClient } from './client';
import { isRecord } from '@/utils/helpers';
import type { AuthFilePaceMode } from '@/types';

/** How long a timed override lasts: a Go duration ("4h") or an RFC 3339 end. */
export type TimedSpan = { duration: string; until?: never } | { until: string; duration?: never };

/**
 * Fork-only gateway usage reserves: a provider's pooled windows in Pro-plan
 * units (GET /usage/pool) and a person's override of their reserve
 * (POST/DELETE /usage/override). Backend: sdk/cliproxy/auth/usage_reserves.go.
 */

export type UsagePoolWindowKind = 'five_hour' | 'weekly';

export interface UsagePoolAccount {
  id: string;
  label: string;
  plan: string;
  /** Plan weight for this window. */
  weight: number;
  usedPercent: number;
  resetAtMs: number | null;
  reservePercent: number;
  /** The reserve held now: reservePercent tapering toward the floor before the reset. */
  reserveNowPercent: number;
  /** The taper has started. */
  reserveReleased: boolean;
  lender: string;
}

export interface UsagePoolRefill {
  atMs: number;
  units: number;
  accountId: string;
}

export interface UsagePoolWindow {
  kind: UsagePoolWindowKind;
  capacity: number;
  left: number;
  leftPercent: number;
  leftForUserPercent: number;
  burnPerHour: number | null;
  /** When the person's share runs out at the current burn; null when unknown or it lasts. */
  emptyAtMs: number | null;
  refills: UsagePoolRefill[];
  accounts: UsagePoolAccount[];
}

export interface UsagePoolUser {
  name: string;
  reservePercent: number;
  softStopped: boolean;
  overrideUntilMs: number | null;
}

export interface UsagePoolReport {
  provider: string;
  checkedAtMs: number;
  user: UsagePoolUser | null;
  activeAccount: { id: string; label: string } | null;
  windows: UsagePoolWindow[];
}

const num = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const time = (value: unknown): number | null => {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const normalizeWindow = (raw: Record<string, unknown>): UsagePoolWindow => ({
  kind: raw.kind === 'weekly' ? 'weekly' : 'five_hour',
  capacity: num(raw.capacity),
  left: num(raw.left),
  leftPercent: num(raw.left_percent),
  leftForUserPercent: num(raw.left_for_user_percent),
  burnPerHour:
    raw.burn_per_hour === null || raw.burn_per_hour === undefined ? null : num(raw.burn_per_hour),
  emptyAtMs: time(raw.empty_at),
  refills: list(raw.refills).flatMap((refill) => {
    const atMs = time(refill.at);
    return atMs === null
      ? []
      : [{ atMs, units: num(refill.units), accountId: str(refill.account_id) }];
  }),
  accounts: list(raw.accounts).map((account) => ({
    id: str(account.id),
    label: str(account.label),
    plan: str(account.plan),
    weight: num(account.weight),
    usedPercent: num(account.used_percent),
    resetAtMs: time(account.reset_at),
    reservePercent: num(account.reserve_percent),
    // Gateways before the taper released the whole reserve at once.
    reserveNowPercent:
      account.reserve_now_percent === undefined
        ? account.reserve_released === true
          ? 0
          : num(account.reserve_percent)
        : num(account.reserve_now_percent),
    reserveReleased: account.reserve_released === true,
    lender: str(account.lender),
  })),
});

export const normalizeUsagePoolReport = (data: unknown): UsagePoolReport => {
  const record = isRecord(data) ? data : {};
  const user = isRecord(record.user) ? record.user : null;
  const active = isRecord(record.active_account) ? record.active_account : null;
  return {
    provider: str(record.provider),
    checkedAtMs: time(record.checked_at) ?? Date.now(),
    user: user
      ? {
          name: str(user.name),
          reservePercent: num(user.reserve_percent),
          softStopped: user.soft_stopped === true,
          overrideUntilMs: time(user.override_until),
        }
      : null,
    activeAccount: active ? { id: str(active.id), label: str(active.label) } : null,
    windows: list(record.windows).map(normalizeWindow),
  };
};

export const usagePoolApi = {
  async getPool(provider: string, user?: string): Promise<UsagePoolReport> {
    const params: Record<string, string> = { provider };
    if (user) params.user = user;
    return normalizeUsagePoolReport(await apiClient.get<unknown>('/usage/pool', { params }));
  },

  /** Lets user ignore their reserve for duration (a Go duration such as "5h"); resolves to its end. */
  async setOverride(user: string, duration: string): Promise<number | null> {
    const data = await apiClient.post<unknown>('/usage/override', { user, duration });
    return time(isRecord(data) ? data.override_until : undefined);
  },

  clearOverride: (user: string) => apiClient.delete('/usage/override', { params: { user } }),

  /**
   * Releases a lender's reserves for a Go duration ("4h") or until an instant,
   * optionally still keeping keepPercent of each window; resolves to its end.
   */
  async setLenderOverride(
    lender: string,
    span: TimedSpan,
    keepPercent?: number
  ): Promise<number | null> {
    const data = await apiClient.post<unknown>('/usage/override', {
      lender,
      ...span,
      ...(keepPercent !== undefined ? { keep_percent: keepPercent } : {}),
    });
    return time(isRecord(data) ? data.override_until : undefined);
  },

  clearLenderOverride: (lender: string) =>
    apiClient.delete('/usage/override', { params: { lender } }),

  /** Sets a credential's pace override; resolves to its end when the gateway reports one. */
  async setPace(name: string, mode: AuthFilePaceMode, span: TimedSpan): Promise<number | null> {
    const data = await apiClient.post<unknown>('/usage/pace', { name, mode, ...span });
    return time(isRecord(data) ? data.until : undefined);
  },

  clearPace: (name: string) => apiClient.delete('/usage/pace', { params: { name } }),
};
