/**
 * Private credentials (gateway `private_user`) serve one person only and record
 * no usage. Usage & quota leaves them out entirely: the page drops them from its
 * credential list, so counts, tabs, pools, the forecast, accounts, spend and
 * reserves never see them, and from the history it shares, so the capacity
 * timeline cannot bring one back as a past credential.
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

/** History without the private credentials' samples and capacity timeline entries. */
export function withoutPrivateHistory(
  history: QuotaHistoryState,
  privateIds: ReadonlySet<string>
): QuotaHistoryState {
  if (history.status !== 'ok' || privateIds.size === 0) return history;
  const shared = <T extends { authId: string }>(items: T[]) =>
    items.filter((item) => !privateIds.has(item.authId));
  return {
    ...history,
    samples: shared(history.samples),
    forecastSamples: shared(history.forecastSamples),
    capacity: history.capacity && shared(history.capacity),
  };
}
