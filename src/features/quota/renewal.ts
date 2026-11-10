/**
 * When an account's plan renews. Codex reports its current period end, so that
 * date is exact. Claude reports only when the subscription started, so its
 * renewal is estimated as the next monthly anniversary (the day clamps to the
 * month's end). A renewal day set in the account's usage settings wins over
 * both and reads as exact. Neither provider says whether it renews
 * automatically, so this is the date the plan renews or ends.
 */

import type { AuthFileItem } from '@/types';
import { resolveCodexSubscriptionActiveUntil, resolveResetMs } from '@/utils/quota';

/** How close a renewal must be for the plan badge to flag it. */
export const RENEWAL_SOON_DAYS = 5;

export interface Renewal {
  atMs: number;
  /** Derived from a monthly anniversary rather than reported. */
  estimated: boolean;
}

const startOfDay = (ms: number) => {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

/** The first local date at or after today that falls on `day` of its month, clamped to month end. */
function nextOnDay(day: number, now: number): number {
  const today = startOfDay(now);
  const from = new Date(now);
  for (let offset = 0; ; offset += 1) {
    const monthEnd = new Date(from.getFullYear(), from.getMonth() + offset + 1, 0).getDate();
    const date = new Date(from.getFullYear(), from.getMonth() + offset, Math.min(day, monthEnd));
    if (date.getTime() >= today) return date.getTime();
  }
}

/** The first monthly anniversary of `startMs` that has not passed before today. */
function nextAnniversary(startMs: number, now: number): number {
  const today = startOfDay(now);
  const start = new Date(startMs);
  const sinceStart =
    (new Date(now).getUTCFullYear() - start.getUTCFullYear()) * 12 +
    new Date(now).getUTCMonth() -
    start.getUTCMonth();
  for (let months = Math.max(0, sinceStart - 1); ; months += 1) {
    const monthEnd = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months + 1, 0)
    ).getUTCDate();
    const candidate = Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth() + months,
      Math.min(start.getUTCDate(), monthEnd),
      start.getUTCHours(),
      start.getUTCMinutes(),
      start.getUTCSeconds()
    );
    if (candidate >= today) return candidate;
  }
}

/**
 * The account's next renewal, or null when nothing is known. `liveActiveUntil`
 * is a loaded Codex card's period end, fresher than the one in the file.
 */
export function resolveRenewal(
  provider: string,
  file: AuthFileItem,
  now: number,
  liveActiveUntil?: string | number | null
): Renewal | null {
  if (file.renewalDay !== undefined) {
    return { atMs: nextOnDay(file.renewalDay, now), estimated: false };
  }
  if (provider === 'codex') {
    const atMs = resolveResetMs([liveActiveUntil, resolveCodexSubscriptionActiveUntil(file)]);
    // A period end already behind us is a stale token, not a renewal.
    return atMs !== null && atMs >= startOfDay(now) ? { atMs, estimated: false } : null;
  }
  if (provider === 'claude' && file.subscriptionCreatedAtMs !== undefined) {
    return { atMs: nextAnniversary(file.subscriptionCreatedAtMs, now), estimated: true };
  }
  return null;
}

/** Whole local days from today to the renewal; 0 on the day itself. */
export const daysUntil = (atMs: number, now: number): number =>
  Math.round((startOfDay(atMs) - startOfDay(now)) / 86_400_000);

export const isRenewalSoon = (renewal: Renewal, now: number): boolean =>
  daysUntil(renewal.atMs, now) <= RENEWAL_SOON_DAYS;
