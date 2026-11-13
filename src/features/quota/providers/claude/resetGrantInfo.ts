import type {
  AnthropicResetGrant,
  AnthropicResetGrantStatus,
  AnthropicResetGrantType,
  AnthropicResetUnavailableReason,
  AnthropicResetWindow,
} from '@/services/api/claudeResetGrants';

export type ResetGrantKind = 'fable' | AnthropicResetGrantType;

/** The Claude Code CLI's kind rule. */
export function resetGrantKind(grant: AnthropicResetGrant): ResetGrantKind {
  if (grant.givesBackWeekly) return 'fable';
  if (grant.type) return grant.type;
  const fiveHour = grant.clears.includes('five_hour');
  if (fiveHour && grant.clears.length === 1) return 'session';
  return fiveHour ? 'full' : 'weekly';
}

export interface ResetGrantGiveBack {
  window: AnthropicResetWindow;
  /** Percent of the window used now, which the reset frees; null when upstream did not say. */
  percent: number | null;
}

/**
 * What a reset gives back, largest first (the CLI's estimate is the first entry). A Fable
 * reset returns what the Fable limit used to the weekly limit; others free each cleared window.
 */
export function resetGrantGivesBack(grant: AnthropicResetGrant): ResetGrantGiveBack[] {
  const windows: AnthropicResetWindow[] = grant.givesBackWeekly
    ? ['seven_day_overage_included']
    : grant.clears;
  return windows
    .map((window) => ({ window, percent: grant.percentUsed[window] ?? null }))
    .sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1));
}

export type ResetGrantBlock =
  | { code: 'ineligible'; reason: string | null }
  | { code: 'not_started'; at: string }
  | { code: 'cooldown'; until: string | null }
  | { code: 'blocked'; windows: AnthropicResetWindow[] }
  | { code: 'exhausted' | 'paused' | 'expired' | 'needs_limit' | 'cannot_clear' | 'unavailable' };

const BLOCKED_WINDOW: Partial<Record<AnthropicResetUnavailableReason, AnthropicResetWindow>> = {
  blocked_five_hour: 'five_hour',
  blocked_seven_day: 'seven_day',
  blocked_opus: 'seven_day_opus',
  blocked_sonnet: 'seven_day_sonnet',
};

/**
 * Why the panel will not spend this grant now, or null when it may. Covers every gate of the
 * pre-claim check (`anthropicResetGrantBlocker` plus dates and cooldown) and names upstream's
 * reason where it gives one.
 */
export function resetGrantBlock(
  status: AnthropicResetGrantStatus,
  grant: AnthropicResetGrant,
  now: number
): ResetGrantBlock | null {
  if (!status.eligible) return { code: 'ineligible', reason: status.ineligibleReason };
  if (grant.resetsLeft <= 0) return { code: 'exhausted' };
  if (grant.paused) return { code: 'paused' };
  if (grant.startsAt && Date.parse(grant.startsAt) > now)
    return { code: 'not_started', at: grant.startsAt };
  if (grant.endsAt && Date.parse(grant.endsAt) <= now) return { code: 'expired' };
  if (status.cooldownUntil && Date.parse(status.cooldownUntil) > now)
    return { code: 'cooldown', until: status.cooldownUntil };
  if (!grant.usableNow) {
    const reason = grant.unavailableReason;
    if (reason === 'cooldown') return { code: 'cooldown', until: status.cooldownUntil };
    if (reason === 'needs_limit' || reason === 'cannot_clear') return { code: reason };
    if (grant.blocking.length > 0) return { code: 'blocked', windows: grant.blocking };
    const window = reason ? BLOCKED_WINDOW[reason] : undefined;
    if (window) return { code: 'blocked', windows: [window] };
    if (reason === 'blocked_other') return { code: 'blocked', windows: [] };
    return { code: 'unavailable' };
  }
  if (grant.useRequiresLimit && !status.atLimit) return { code: 'needs_limit' };
  return null;
}
