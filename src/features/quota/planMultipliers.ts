/**
 * Plan multipliers: quota in units of the base plan.
 *
 * A credential's multiplier m is its plan's size in base plans for one window.
 * The gateway reports it per window (plan_weight_five_hour / plan_weight_weekly):
 * Claude plans have fixed weights (Pro 1/1, Max 5/5, Ultra 20 five-hour but 10
 * weekly), other credentials use their price-based plan_multiplier in both
 * windows. Older gateways without weights fall back to plan_multiplier here.
 * The lender reserve r of that window is kept for the account's owner, so
 * c = 100 − r percent is ours (legacy usage_cap_percent: c = cap): our effective
 * multiplier is E = m × c/100. With u% of a window used, what is left to us is
 * R = m × max(0, c − u)/100.
 */

import type { AuthFileItem } from '@/types';

/** The gateway's window kinds: Claude 5h / Codex primary / Muse session, and weekly. */
export type PlanWindow = 'five_hour' | 'weekly';

export interface PlanShare {
  /** Base-plan units for the window; 1 when not set. */
  multiplier: number;
  /** False when the credential has neither a known plan nor a multiplier and 1 is assumed. */
  multiplierSet: boolean;
  /** Our share of the account in percent: 100 − its lender reserve, else 100. */
  capPercent: number;
  /** m × c / 100. */
  effective: number;
}

/** Claude plan names the gateway weighs, canonical as the listing reports them. */
const CLAUDE_WEIGHED_PLANS = new Set(['pro', 'max', 'ultra']);

type PlanShareSource = Pick<
  AuthFileItem,
  | 'type'
  | 'provider'
  | 'plan'
  | 'planMultiplier'
  | 'usageCapPercent'
  | 'planWeightFiveHour'
  | 'planWeightWeekly'
  | 'reserveFiveHourPercent'
  | 'reserveWeeklyPercent'
>;

/** A credential's multiplier and our share of it in one window; the API layer has validated all fields. */
export function planShareOf(file: PlanShareSource, window: PlanWindow): PlanShare {
  const weekly = window === 'weekly';
  const weight = weekly ? file.planWeightWeekly : file.planWeightFiveHour;
  const reserve = weekly ? file.reserveWeeklyPercent : file.reserveFiveHourPercent;
  const provider = String(file.type ?? file.provider ?? '').toLowerCase();
  const knownPlan = provider === 'claude' && CLAUDE_WEIGHED_PLANS.has(file.plan ?? '');
  const multiplier = weight ?? file.planMultiplier ?? 1;
  const capPercent = reserve !== undefined ? 100 - reserve : (file.usageCapPercent ?? 100);
  return {
    multiplier,
    multiplierSet: knownPlan || file.planMultiplier !== undefined,
    capPercent,
    effective: (multiplier * capPercent) / 100,
  };
}

/** What is left to us of a window with usedPercent used: m × max(0, c − u)/100. */
export const remainingMultiplier = (share: PlanShare, usedPercent: number): number =>
  (share.multiplier * Math.max(0, share.capPercent - usedPercent)) / 100;

export interface MultiplierReading {
  share: PlanShare;
  /** The window's used percent, or null when the credential reports none. */
  usedPercent: number | null;
}

export interface MultiplierTotals {
  /** Σm over every credential. */
  plans: number;
  /** ΣE over every credential. */
  effective: number;
  /** Credentials without a plan multiplier, counted as 1. */
  unset: number;
  /** ΣR over the credentials with a reading. */
  remaining: number;
  /** ΣE over the same credentials: what `remaining` is a share of. */
  readEffective: number;
  /** Credentials without a reading, left out of `remaining`. */
  unread: number;
}

export function multiplierTotals(readings: readonly MultiplierReading[]): MultiplierTotals {
  return readings.reduce<MultiplierTotals>(
    (totals, { share, usedPercent }) => ({
      plans: totals.plans + share.multiplier,
      effective: totals.effective + share.effective,
      unset: totals.unset + (share.multiplierSet ? 0 : 1),
      remaining:
        totals.remaining + (usedPercent === null ? 0 : remainingMultiplier(share, usedPercent)),
      readEffective: totals.readEffective + (usedPercent === null ? 0 : share.effective),
      unread: totals.unread + (usedPercent === null ? 1 : 0),
    }),
    { plans: 0, effective: 0, unset: 0, remaining: 0, readEffective: 0, unread: 0 }
  );
}

/** Remaining as a share of what it could be, 0..1; null when there is nothing to share. */
export const shareLeft = (remaining: number, of: number): number | null =>
  of > 0 ? Math.min(1, remaining / of) : null;

/**
 * "3.4×", "0.75×", "11×": two decimals at most, two significant digits below
 * 0.1 so a slow hourly drain does not round to zero.
 */
export function formatMultiplier(value: number, language?: string): string {
  const options: Intl.NumberFormatOptions =
    value !== 0 && Math.abs(value) < 0.1
      ? { maximumSignificantDigits: 2 }
      : { maximumFractionDigits: 2 };
  return `${new Intl.NumberFormat(language, options).format(value)}×`;
}

/** An account card's multiplier: its plan and share, and what is left of its pooled window. */
export interface AccountMultiplier {
  share: PlanShare;
  /** R of the pooled window now; null without a reading. */
  remaining: number | null;
  /** Whether that window is weekly. */
  weekly: boolean;
}
