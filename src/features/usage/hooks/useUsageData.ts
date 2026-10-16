import { useCallback, useEffect, useRef, useState } from 'react';
import { apiKeysApi, usageLedgerApi } from '@/services/api';
import { useAuthStore } from '@/stores';
import type { UsageClient, UsageClientLabel, UsageLedger } from '@/types';
import { HOUR_MS } from '@/utils/time/durations';
import { LEDGER_SPAN_MS } from '../usageModel';

export interface UsageData {
  ledger: UsageLedger | null;
  /** Labels from the clients endpoint; null when it failed (the ledger's copy is used). */
  clients: UsageClient[] | null;
  apiKeys: string[];
  /** Ledger error message, empty when the ledger loaded. */
  error: string;
  /** The backend reported the ledger as disabled (409). */
  disabled: boolean;
  loading: boolean;
}

const EMPTY: UsageData = {
  ledger: null,
  clients: null,
  apiKeys: [],
  error: '',
  disabled: false,
  loading: true,
};

/** Ledger for every window shown, the client labels, and configured keys for key hints. */
export function useUsageData() {
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const [data, setData] = useState<UsageData>(EMPTY);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (!connected) {
      setData({ ...EMPTY, loading: false });
      return;
    }
    setData((prev) => ({ ...prev, loading: true }));
    const now = Date.now();
    // Hour-aligned start: every window shown begins inside this span in either anchor mode.
    const from = Math.floor((now - LEDGER_SPAN_MS) / HOUR_MS) * HOUR_MS;
    const [ledger, clients, apiKeys] = await Promise.allSettled([
      usageLedgerApi.getLedger(from, now),
      usageLedgerApi.getClients(),
      apiKeysApi.list(),
    ]);
    if (requestId !== requestRef.current) return;
    setData({
      ledger: ledger.status === 'fulfilled' ? ledger.value : null,
      clients: clients.status === 'fulfilled' ? clients.value : null,
      apiKeys: apiKeys.status === 'fulfilled' ? apiKeys.value : [],
      error:
        ledger.status === 'rejected'
          ? ledger.reason instanceof Error
            ? ledger.reason.message
            : String(ledger.reason)
          : '',
      disabled:
        ledger.status === 'rejected' && (ledger.reason as { status?: number } | null)?.status === 409,
      loading: false,
    });
  }, [connected]);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  const saveClients = useCallback(
    async (labels: UsageClientLabel[]) => {
      await usageLedgerApi.saveClients(labels);
      await load();
    },
    [load]
  );

  return { ...data, reload: load, saveClients };
}
