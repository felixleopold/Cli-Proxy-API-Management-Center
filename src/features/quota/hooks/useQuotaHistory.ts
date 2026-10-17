import { useEffect, useState } from 'react';
import { quotaHistoryApi, type QuotaHistorySample } from '@/services/api';
import { DAY_MS } from '../quotaForecastModel';

/**
 * Fourteen days back: seven to draw, seven more so every credential has a
 * sample before the drawn range starts (samples are only recorded on change).
 */
const HISTORY_LOOKBACK_MS = 14 * DAY_MS;

export type QuotaHistoryState =
  | { status: 'loading' }
  | { status: 'ok'; samples: QuotaHistorySample[] }
  | { status: 'disabled' }
  | { status: 'error' };

/**
 * Loads quota history whenever `reloadKey` changes (the credential list reloads).
 * A response for an older key never overwrites a newer one; while reloading,
 * the previous result stays on screen.
 */
export function useQuotaHistory(enabled: boolean, reloadKey: unknown): QuotaHistoryState {
  const [state, setState] = useState<QuotaHistoryState>({ status: 'loading' });

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const nowMs = Date.now();
    quotaHistoryApi.list(nowMs - HISTORY_LOOKBACK_MS, nowMs).then(
      (result) => {
        if (current) setState(result);
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
