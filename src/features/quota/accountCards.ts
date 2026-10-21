/**
 * One card per account on the Usage & quota page. A quota card pairs with its
 * spend summary by the credential's auth id, which the ledger records as
 * `auth_id` and the spend summaries are keyed by. Spend for a credential
 * without a quota card (a provider without quota support) still gets a card.
 */

import { parseSubscription, type SubscriptionSummary } from '@/features/usage/usageModel';
import type { QuotaFileEntry } from './logic';

export interface AccountSpendPairing {
  spendFor: (entry: QuotaFileEntry) => SubscriptionSummary | null;
  /** Summaries that no quota card claims and that match the search, in their given order. */
  spendOnly: SubscriptionSummary[];
}

/**
 * `entries` are all quota cards before search and paging, so a card hidden by
 * either never turns its spend into a second, spend-only card.
 */
export function pairAccountSpend(
  entries: readonly QuotaFileEntry[],
  summaries: readonly SubscriptionSummary[],
  search: string
): AccountSpendPairing {
  const byId = new Map(summaries.map((summary) => [summary.subscription.id, summary]));
  const claimed = new Set(entries.map((entry) => parseSubscription(entry.file).id));
  const query = search.trim().toLowerCase();
  return {
    spendFor: (entry) => byId.get(parseSubscription(entry.file).id) ?? null,
    spendOnly: summaries.filter(
      ({ subscription }) =>
        !claimed.has(subscription.id) &&
        (!query ||
          [subscription.name, subscription.id].some((value) => value.toLowerCase().includes(query)))
    ),
  };
}
