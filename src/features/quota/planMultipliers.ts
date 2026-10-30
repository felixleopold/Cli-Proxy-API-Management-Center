/**
 * Plan multipliers: quota in units of the base $20 plan.
 *
 * A credential's plan multiplier m is its plan's size in base plans (Max $200 =
 * 10, Pro/Plus = 1). Its usage cap c stops the gateway using it once a window
 * reaches c%, so c% of the account is ours: our effective multiplier is
 * E = m × c/100. With u% of a window used, what is left to us is
 * R = m × max(0, c − u)/100. The same multiplier applies to every window.
 */

import type { AuthFileItem } from '@/types';

export interface PlanShare {
  /** Base-plan units; 1 when not set. */
  multiplier: number;
  /** False when the credential has no plan multiplier and 1 is assumed. */
  multiplierSet: boolean;
  /** Our share of the account in percent: its usage cap, else 100. */
  capPercent: number;
  /** m × c / 100. */
  effective: number;
}

/** The credential's plan multiplier and our share of it; the API layer has validated both. */
export function planShareOf(
  file: Pick<AuthFileItem, 'planMultiplier' | 'usageCapPercent'>
): PlanShare {
  const multiplierSet = file.planMultiplier !== undefined;
  const multiplier = file.planMultiplier ?? 1;
  const capPercent = file.usageCapPercent ?? 100;
  return { multiplier, multiplierSet, capPercent, effective: (multiplier * capPercent) / 100 };
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
