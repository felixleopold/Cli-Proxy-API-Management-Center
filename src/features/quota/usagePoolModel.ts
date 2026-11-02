/**
 * Pooled usage from the gateway's usage reserves (GET /usage/pool): pure
 * helpers for the Usage & quota page's pool panel (components/UsagePool.tsx).
 * Units are Pro-plan units with the per-window plan weights the gateway uses.
 */

import type {
  UsagePoolAccount,
  UsagePoolRefill,
  UsagePoolReport,
  UsagePoolUser,
  UsagePoolWindow,
} from '@/services/api/usagePool';
import { AUTH_FILE_USAGE_CAP_PROVIDERS } from '@/features/authFiles/constants';
import type { AuthFileItem } from '@/types';

/**
 * A credential's lender reserve in a window: `none` without one, `reached`
 * when usage is at the ceiling (100 − the reserve held now) so the gateway
 * holds the account back, `tapering` once the reserve shrinks toward its floor
 * before the reset, else `held`.
 */
export type ReserveState = 'none' | 'held' | 'tapering' | 'reached';

export function reserveStateOf(account: UsagePoolAccount): ReserveState {
  if (account.reservePercent <= 0) return 'none';
  if (account.usedPercent >= 100 - account.reserveNowPercent) return 'reached';
  return account.reserveNowPercent < account.reservePercent ? 'tapering' : 'held';
}

/** The person's override end while it lasts, else null. */
export function activeOverrideUntil(user: UsagePoolUser | null, nowMs: number): number | null {
  const until = user?.overrideUntilMs ?? null;
  return until !== null && until > nowMs ? until : null;
}

/** Pool reports together with the person they were fetched for ('' for everyone). */
export interface ScopedPoolReports {
  user: string;
  reports: UsagePoolReport[];
}

/**
 * The reports fetched for user, else none, so a previous person's reports are
 * never shown (or acted on) while the next person's are loading or failed.
 */
export const reportsFor = (loaded: ScopedPoolReports | null, user: string): UsagePoolReport[] =>
  loaded !== null && loaded.user === user ? loaded.reports : [];

/**
 * Whose override the switch may change: the selected user, only once the shown
 * reports are that person's (the gateway matches names case-insensitively).
 */
export function overrideTarget(reports: UsagePoolReport[], user: string): string | null {
  const shown = reports.find((report) => report.user)?.user;
  return user && shown && shown.name.toLowerCase() === user.toLowerCase() ? user : null;
}

/** What an override change needs: the gateway call, the current selection and its refresh. */
export interface OverrideChangeDeps {
  set: (user: string, on: boolean) => Promise<unknown>;
  selected: () => string;
  refresh: () => Promise<void>;
}

/**
 * Changes target's override, then refreshes only if target is still the
 * selected person. A refresh for someone the panel has switched away from would
 * replace the new person's reports with target's, which reportsFor then hides.
 */
export async function changeOverride(
  target: string,
  on: boolean,
  { set, selected, refresh }: OverrideChangeDeps
): Promise<void> {
  await set(target, on);
  if (selected() === target) await refresh();
}

/** Refills still ahead, soonest first, with their total. */
export function upcomingRefills(window: UsagePoolWindow, nowMs: number) {
  const refills: UsagePoolRefill[] = window.refills.filter((refill) => refill.atMs > nowMs);
  return { refills, total: refills.reduce((sum, refill) => sum + refill.units, 0) };
}

/** Providers whose windows the gateway pools, with an enabled credential, in a stable order. */
export function poolProviders(files: AuthFileItem[], tab: string): string[] {
  const providers = new Set(
    files
      .filter((file) => !file.disabled)
      .map((file) => String(file.type ?? file.provider ?? '').toLowerCase())
      .filter((provider) => AUTH_FILE_USAGE_CAP_PROVIDERS.has(provider))
  );
  return [...AUTH_FILE_USAGE_CAP_PROVIDERS].filter(
    (provider) => providers.has(provider) && (tab === 'all' || tab === provider)
  );
}

/** "14:05" today, "Tue 14:05" within a week, else a short date with the time. */
export function formatPoolTime(atMs: number, nowMs: number, language?: string): string {
  const at = new Date(atMs);
  const clock = { hour: '2-digit', minute: '2-digit' } as const;
  if (at.toDateString() === new Date(nowMs).toDateString()) {
    return new Intl.DateTimeFormat(language, clock).format(at);
  }
  const withinWeek = Math.abs(atMs - nowMs) < 6 * 24 * 60 * 60 * 1000;
  return new Intl.DateTimeFormat(
    language,
    withinWeek ? { weekday: 'short', ...clock } : { month: 'short', day: 'numeric', ...clock }
  ).format(at);
}
