/**
 * Timed controls of the Usage & quota page: a credential's pace override
 * (POST /usage/pace, ⚡ flash routes to it first, shield holds it back until
 * nothing else is eligible) and a lender's reserve release (POST
 * /usage/override). Both last a duration or until an instant; "until the next
 * 5-hour / weekly reset" resolves here, from the readings the rows show, to an
 * instant the gateway gets as `until`.
 */

import type { TimedSpan } from '@/services/api/usagePool';
import type { AuthFileItem, AuthFilePaceMode } from '@/types';
import { HOUR_MS } from '@/utils/time/durations';
import { lenderReleaseUntil, showsLenderRelease } from './usagePoolModel';

/** What a timed control's menu offers. */
export type TimedChoice =
  | { kind: 'five_hour' }
  | { kind: 'weekly' }
  | { kind: 'hours'; hours: number }
  | { kind: 'at'; atMs: number };

/** The next reset of each window, when known. */
export interface NextResets {
  fiveHour: number | null;
  weekly: number | null;
}

/**
 * The request span of a choice and when it ends. Null when the choice names a
 * reset nothing reports, or an instant that is not in the future.
 */
export function resolveTimedChoice(
  choice: TimedChoice,
  resets: NextResets,
  nowMs: number
): { span: TimedSpan; untilMs: number } | null {
  if (choice.kind === 'hours') {
    return { span: { duration: `${choice.hours}h` }, untilMs: nowMs + choice.hours * HOUR_MS };
  }
  const atMs =
    choice.kind === 'at'
      ? choice.atMs
      : choice.kind === 'five_hour'
        ? resets.fiveHour
        : resets.weekly;
  if (atMs === null || !Number.isFinite(atMs) || atMs <= nowMs) return null;
  return { span: { until: new Date(atMs).toISOString() }, untilMs: atMs };
}

/**
 * The share a release keeps, as the gateway takes it (0 < x < 100): null for
 * empty text (release the whole reserve), undefined for anything outside 1–99.
 */
export function parseKeepPercentText(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value >= 1 && value <= 99 ? value : undefined;
}

/** The credential's pace override while it lasts, else null. */
export function activePace(
  file: Pick<AuthFileItem, 'paceMode' | 'paceUntilMs'>,
  nowMs: number
): { mode: AuthFilePaceMode; untilMs: number } | null {
  const { paceMode, paceUntilMs } = file;
  return paceMode && paceUntilMs !== undefined && paceUntilMs > nowMs
    ? { mode: paceMode, untilMs: paceUntilMs }
    : null;
}

/** One lender of the Reserves strip: what it keeps, over how many accounts, and its release. */
export interface LenderReserve {
  lender: string;
  accounts: number;
  /** The highest reserve of each window over the lender's accounts; null when none is set. */
  fiveHourPercent: number | null;
  weeklyPercent: number | null;
  release: { untilMs: number; keepPercent: number | null } | null;
  /** The soonest next reset of each window over the lender's accounts. */
  resets: NextResets;
}

const maxOf = (values: (number | undefined)[]): number | null => {
  const known = values.filter((value): value is number => value !== undefined);
  return known.length > 0 ? Math.max(...known) : null;
};
const soonest = (values: (number | null)[]): number | null => {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? Math.min(...known) : null;
};

/**
 * Lenders with a reserve to release (or a release running), by name. The legacy
 * usage cap stands for a reserve of 100 − cap in both windows, as the gateway
 * applies it. Disabled credentials join no pool and are left out.
 */
export function lenderReserves(
  files: readonly AuthFileItem[],
  resetsFor: (file: AuthFileItem) => NextResets,
  nowMs: number
): LenderReserve[] {
  const byLender = new Map<string, AuthFileItem[]>();
  files.forEach((file) => {
    if (file.disabled || !file.lender || !showsLenderRelease(file, nowMs)) return;
    byLender.set(file.lender, [...(byLender.get(file.lender) ?? []), file]);
  });
  return [...byLender.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([lender, accounts]) => {
      const legacy = (file: AuthFileItem) =>
        file.usageCapPercent !== undefined ? 100 - file.usageCapPercent : undefined;
      const untilMs = soonest(accounts.map((file) => lenderReleaseUntil(file, nowMs)));
      const resets = accounts.map(resetsFor);
      return {
        lender,
        accounts: accounts.length,
        fiveHourPercent: maxOf(accounts.map((file) => file.reserveFiveHourPercent ?? legacy(file))),
        weeklyPercent: maxOf(accounts.map((file) => file.reserveWeeklyPercent ?? legacy(file))),
        release:
          untilMs === null
            ? null
            : {
                untilMs,
                keepPercent:
                  accounts.find((file) => file.lenderReserveOverrideKeepPercent !== undefined)
                    ?.lenderReserveOverrideKeepPercent ?? null,
              },
        resets: {
          fiveHour: soonest(resets.map((reset) => reset.fiveHour)),
          weekly: soonest(resets.map((reset) => reset.weekly)),
        },
      };
    });
}
