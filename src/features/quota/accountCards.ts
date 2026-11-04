/**
 * One row per account on the Usage & quota page. A quota row pairs with its
 * spend summary by the credential's auth id, which the ledger records as
 * `auth_id` and the spend summaries are keyed by. Spend for a credential
 * without quota support still gets a row.
 */

import { parseSubscription, type SubscriptionSummary } from '@/features/usage/usageModel';
import type { AuthFileItem } from '@/types';
import { HOUR_MS } from '@/utils/time/durations';
import type { QuotaFileEntry } from './logic';
import type { CardReading, PoolCredential } from './quotaForecastModel';

export interface AccountSpendPairing {
  spendFor: (entry: QuotaFileEntry) => SubscriptionSummary | null;
  /** Summaries that no quota card claims and that match the search, in their given order. */
  spendOnly: SubscriptionSummary[];
  /** The credential file behind a spend-only summary, when the listing has it. */
  fileFor: (summary: SubscriptionSummary) => AuthFileItem | null;
}

/**
 * `entries` are all quota cards before search and paging, so a card hidden by
 * either never turns its spend into a second, spend-only card. `files` gives
 * spend-only cards their file name for search, as quota cards search it.
 */
export function pairAccountSpend(
  entries: readonly QuotaFileEntry[],
  summaries: readonly SubscriptionSummary[],
  search: string,
  files: readonly AuthFileItem[]
): AccountSpendPairing {
  const byId = new Map(summaries.map((summary) => [summary.subscription.id, summary]));
  const claimed = new Set(entries.map((entry) => parseSubscription(entry.file).id));
  const filesById = new Map(files.map((file) => [parseSubscription(file).id, file]));
  const query = search.trim().toLowerCase();
  return {
    spendFor: (entry) => byId.get(parseSubscription(entry.file).id) ?? null,
    spendOnly: summaries.filter(
      ({ subscription }) =>
        !claimed.has(subscription.id) &&
        (!query ||
          [subscription.name, subscription.id, filesById.get(subscription.id)?.name ?? ''].some(
            (value) => value.toLowerCase().includes(query)
          ))
    ),
    fileFor: (summary) => filesById.get(summary.subscription.id) ?? null,
  };
}

/** One quota window of an account row, as of now. */
export interface AccountWindow {
  /** Percent of the window left, 0..100. */
  leftPercent: number;
  /** Next reset; null when unknown (an idle 5-hour window, or a live reading without one). */
  resetAtMs: number | null;
  periodMs: number;
}

/** The two bars of an account row: the 5-hour window and the weekly (else longest) one. */
export interface AccountWindows {
  short: AccountWindow | null;
  long: AccountWindow | null;
}

interface WindowSource {
  usedPercent: number;
  resetAtMs: number | null;
  periodMs: number;
}

const SHORT_PERIOD_MS = 5 * HOUR_MS;

/** A reset that has passed means the window is full again, with the next reset a period on. */
function windowNow(
  { usedPercent, resetAtMs, periodMs }: WindowSource,
  nowMs: number
): AccountWindow {
  let next = resetAtMs;
  let used = usedPercent;
  if (next !== null && nowMs >= next) {
    next += periodMs > 0 ? (Math.floor((nowMs - next) / periodMs) + 1) * periodMs : 0;
    used = 0;
  }
  return { leftPercent: Math.min(100, Math.max(0, 100 - used)), resetAtMs: next, periodMs };
}

export interface AccountWindowSources {
  /** The credential as the forecast pools read it: live signals, else its latest history. */
  pooled: PoolCredential | null;
  /** The loaded quota card's windows. */
  card: CardReading | null;
  /** The live 5-hour window, which the pools leave out when a weekly one exists. */
  liveShort: { minutes: number; usedPercent: number } | null;
  nowMs: number;
}

/**
 * The row's two windows from the same readings as the pool cards, so a row
 * reads before its quota card loads: the pooled reading wins for its window,
 * the loaded card fills the other one. A window nothing reports stays null and
 * renders as unknown, never as an empty bar.
 */
export function accountWindows({
  pooled,
  card,
  liveShort,
  nowMs,
}: AccountWindowSources): AccountWindows {
  // A card without a 5-hour window falls back to a longer one there (e.g. Devin's daily).
  const cardShort = card?.short && card.short.periodMs <= SHORT_PERIOD_MS ? card.short : null;
  const cardLong = card && (!cardShort || card.periodMs > cardShort.periodMs) ? card : null;
  const long = pooled?.window === 'weekly' ? pooled : cardLong;
  const short: WindowSource | null =
    pooled?.window === 'session'
      ? pooled
      : liveShort
        ? {
            usedPercent: liveShort.usedPercent,
            resetAtMs: null,
            periodMs: liveShort.minutes * 60_000,
          }
        : cardShort;
  return {
    short: short ? windowNow(short, nowMs) : null,
    long: long ? windowNow(long, nowMs) : null,
  };
}
