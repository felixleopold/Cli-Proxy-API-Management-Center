import { useEffect, useState } from 'react';
import { quotaHistoryApi, usageLedgerApi, type QuotaHistorySample } from '@/services/api';
import type { UsageLedgerBucket } from '@/types';
import { DAY_MS } from '../quotaForecastModel';

/**
 * Fourteen days back: seven to draw, seven more so every credential has a
 * sample before the drawn range starts (samples are only recorded on change).
 */
const HISTORY_LOOKBACK_MS = 14 * DAY_MS;

export type QuotaHistoryState =
  | { status: 'loading' }
  /** `ledger` is null when the usage ledger is off (409) or failed: the forecast does without it. */
  | { status: 'ok'; samples: QuotaHistorySample[]; ledger: UsageLedgerBucket[] | null }
  | { status: 'disabled' }
  | { status: 'error' };

/**
 * Loads quota history, and the usage ledger over the same span, whenever
 * `reloadKey` changes (the credential list reloads).
 * A response for an older key never overwrites a newer one; while reloading,
 * the previous result stays on screen.
 */
export function useQuotaHistory(enabled: boolean, reloadKey: unknown): QuotaHistoryState {
  const [state, setState] = useState<QuotaHistoryState>({ status: 'loading' });

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const nowMs = Date.now();
    const fromMs = nowMs - HISTORY_LOOKBACK_MS;
    Promise.all([
      quotaHistoryApi.list(fromMs, nowMs),
      usageLedgerApi.getLedger(fromMs, nowMs).then(
        (ledger) => ledger.buckets,
        () => null
      ),
    ]).then(
      ([result, ledger]) => {
        if (current) setState(result.status === 'ok' ? { ...result, ledger } : result);
      },
      () => {
        if (current) setState({ status: 'error' });
      }
    );
    return () => {
      current = false;
    };
  }, [enabled, reloadKey]);

  return state;
}
