/**
 * Private credentials (gateway `private_user`) serve one person only and record
 * no usage. Usage & quota and the Dashboard leave them out entirely: the pages
 * drop them from their credential lists, so counts, tabs, pools, the forecast,
 * accounts, spend and reserves never see them; and from the history and ledger,
 * so neither the capacity timeline nor spend from before a credential was made
 * private brings one back.
 */

import type { AuthFileItem } from '@/types';
import type { QuotaHistoryState } from './hooks/useQuotaHistory';

/** The shared credentials, and the auth ids of the private ones. */
export function splitPrivateCredentials(files: readonly AuthFileItem[]): {
  shared: AuthFileItem[];
  privateIds: ReadonlySet<string>;
} {
  const shared: AuthFileItem[] = [];
  const privateIds = new Set<string>();
  files.forEach((file) => {
    if (!file.privateUser) shared.push(file);
    else privateIds.add(typeof file.id === 'string' && file.id ? file.id : file.name);
  });
  return { shared, privateIds };
}

/** Records without those of private credentials (ledger buckets, samples, timeline entries). */
export const withoutPrivate = <T extends { authId: string }>(
  items: T[],
  privateIds: ReadonlySet<string>
): T[] => (privateIds.size === 0 ? items : items.filter((item) => !privateIds.has(item.authId)));

/** History without the private credentials' samples, capacity timeline entries and spend. */
export function withoutPrivateHistory(
  history: QuotaHistoryState,
  privateIds: ReadonlySet<string>
): QuotaHistoryState {
  if (history.status !== 'ok' || privateIds.size === 0) return history;
  return {
    ...history,
    samples: withoutPrivate(history.samples, privateIds),
    forecastSamples: withoutPrivate(history.forecastSamples, privateIds),
    ledger: history.ledger && withoutPrivate(history.ledger, privateIds),
    capacity: history.capacity && withoutPrivate(history.capacity, privateIds),
  };
}
