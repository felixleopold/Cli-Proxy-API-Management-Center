/**
 * Display logic for the Claude API credit switch. Pure and clock-free: `nowMs`
 * comes from the caller (see `useNow`).
 */

import type { ClaudeCreditFallback } from '@/services/api';
import { MINUTE_MS } from '@/utils/time/durations';

export type ClaudeCreditStatus =
  | { on: false }
  | { on: true; untilMs: number; remainingMinutes: number }
  | { on: true; untilMs: null; remainingMinutes: null };

/**
 * On until `expiresAtMs`. A switch past its expiry reads as off: the gateway has
 * turned it off and the next poll will say so. Remaining time is truncated (never
 * claims more than is left) and floors at 1 minute so it never reads "0 min".
 */
export function claudeCreditStatus(state: ClaudeCreditFallback, nowMs: number): ClaudeCreditStatus {
  if (!state.enabled) return { on: false };
  if (state.expiresAtMs === null) return { on: true, untilMs: null, remainingMinutes: null };
  const remainingMs = state.expiresAtMs - nowMs;
  if (remainingMs <= 0) return { on: false };
  return {
    on: true,
    untilMs: state.expiresAtMs,
    remainingMinutes: Math.max(1, Math.floor(remainingMs / MINUTE_MS)),
  };
}

/** Whole hours and leftover minutes, e.g. 112 → { hours: 1, minutes: 52 }. */
export function splitMinutes(totalMinutes: number): { hours: number; minutes: number } {
  const whole = Math.max(0, Math.floor(totalMinutes));
  return { hours: Math.floor(whole / 60), minutes: whole % 60 };
}

/** Browser-local 24-hour clock time, e.g. `18:40`. */
export function formatClockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
