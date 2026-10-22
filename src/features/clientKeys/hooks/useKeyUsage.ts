import { useEffect, useState } from 'react';
import { clientKeysApi, type ClientKeyUsage } from '@/services/api/clientKeys';
import { getErrorMessage } from '@/utils/helpers';
import { usageRangeWindow, type UsageRangeId, type UsageRangeWindow } from '../clientKeysModel';

export interface KeyUsageState {
  /** The request this state answers; anything else is still loading. */
  requestKey: string;
  usage: ClientKeyUsage | null;
  /** The window the usage was asked for, so the chart matches it. */
  window: UsageRangeWindow | null;
  /** `usage-ledger.enabled` is off (409). */
  ledgerOff: boolean;
  error: string;
}

/** One key's usage over a range, fetched when the key or the range changes. */
export function useKeyUsage(id: string, range: UsageRangeId) {
  const requestKey = `${id}\u0000${range}`;
  const [state, setState] = useState<KeyUsageState>({
    requestKey: '',
    usage: null,
    window: null,
    ledgerOff: false,
    error: '',
  });

  useEffect(() => {
    let cancelled = false;
    const window = usageRangeWindow(range, Date.now());
    clientKeysApi
      .usage(id, window.fromMs, window.toMs)
      .then((usage) => {
        if (!cancelled) setState({ requestKey, usage, window, ledgerOff: false, error: '' });
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        const ledgerOff = (reason as { status?: number } | null)?.status === 409;
        setState({
          requestKey,
          usage: null,
          window,
          ledgerOff,
          error: ledgerOff ? '' : getErrorMessage(reason),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [id, range, requestKey]);

  return { ...state, loading: state.requestKey !== requestKey };
}
