import { useEffect, useState } from 'react';
import {
  capacityHistoryApi,
  quotaHistoryApi,
  usageLedgerApi,
  type CapacityEntry,
  type QuotaHistorySample,
} from '@/services/api';
import type { UsageLedgerBucket } from '@/types';
import { DAY_MS } from '../quotaForecastModel';

/**
 * The forecast's inputs (pools, learned activity, burn, drain) and the ledger stay
 * on the last two weeks whatever past range the chart draws, so widening the
 * range never changes the forecast.
 */
const FORECAST_LOOKBACK_MS = 14 * DAY_MS;

export type QuotaHistoryState =
  | { status: 'loading' }
  /**
   * `ledger` is null when the usage ledger is off (409) or failed: the forecast does without it.
   * `capacity` is null when the gateway has no capacity timeline: capacity is then today's.
   */
  | {
      status: 'ok';
      /** Everything loaded, for drawing the chosen past range. */
      samples: QuotaHistorySample[];
      /** The last two weeks of `samples`, for everything that forecasts or reads current state. */
      forecastSamples: QuotaHistorySample[];
      ledger: UsageLedgerBucket[] | null;
      capacity: CapacityEntry[] | null;
    }
  | { status: 'disabled' }
  | { status: 'error' };

/**
 * Loads quota history and the capacity timeline over `lookbackDays`, and the
 * usage ledger over the last two weeks, whenever `reloadKey` or the span changes
 * (the credential list reloads, or the forecast's past range widens).
 * A response for an older key never overwrites a newer one; while reloading,
 * the previous result stays on screen.
 */
export function useQuotaHistory(
  enabled: boolean,
  reloadKey: unknown,
  lookbackDays = 14
): QuotaHistoryState {
  const [state, setState] = useState<QuotaHistoryState>({ status: 'loading' });

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const nowMs = Date.now();
    const fromMs = nowMs - lookbackDays * DAY_MS;
    Promise.all([
      quotaHistoryApi.list(fromMs, nowMs),
      usageLedgerApi.getLedger(nowMs - FORECAST_LOOKBACK_MS, nowMs).then(
        (ledger) => ledger.buckets,
        () => null
      ),
      capacityHistoryApi.list(fromMs, nowMs).then(
        (timeline) => (timeline.status === 'ok' ? timeline.entries : null),
        () => null
      ),
    ]).then(
      ([result, ledger, capacity]) => {
        if (!current) return;
        if (result.status !== 'ok') {
          setState(result);
          return;
        }
        const forecastSamples = result.samples.filter(
          (sample) => sample.atMs >= nowMs - FORECAST_LOOKBACK_MS
        );
        setState({ ...result, forecastSamples, ledger, capacity });
      },
      () => {
        if (current) setState({ status: 'error' });
      }
    );
    return () => {
      current = false;
    };
  }, [enabled, reloadKey, lookbackDays]);

  return state;
}
