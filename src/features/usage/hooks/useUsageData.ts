import { useCallback, useEffect, useRef, useState } from 'react';
import { apiKeysApi, usageLedgerApi } from '@/services/api';
import { useAuthStore } from '@/stores';
import type { UsageClient, UsageClientLabel, UsageLedger } from '@/types';
import { ledgerNeedsReload } from '../usageModel';

interface Directory {
  /** Labels from the clients endpoint; null when it failed (the ledger's copy is used). */
  clients: UsageClient[] | null;
  apiKeys: string[];
  loaded: boolean;
}

const EMPTY_DIRECTORY: Directory = { clients: null, apiKeys: [], loaded: false };

/** Client labels and configured keys (for key hints). */
export function useUsageDirectory() {
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const [directory, setDirectory] = useState<Directory>(EMPTY_DIRECTORY);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (!connected) {
      setDirectory({ ...EMPTY_DIRECTORY, loaded: true });
      return;
    }
    const [clients, apiKeys] = await Promise.allSettled([
      usageLedgerApi.getClients(),
      apiKeysApi.list(),
    ]);
    if (requestId !== requestRef.current) return;
    setDirectory({
      clients: clients.status === 'fulfilled' ? clients.value : null,
      apiKeys: apiKeys.status === 'fulfilled' ? apiKeys.value : [],
      loaded: true,
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

  return { ...directory, reload: load, saveClients };
}

interface LedgerState {
  ledger: UsageLedger | null;
  /** Start of the span `ledger` covers. */
  fromMs: number | null;
  /** Error message, empty when the ledger loaded. */
  error: string;
  /** The backend reported the ledger as disabled (409). */
  disabled: boolean;
  loading: boolean;
}

const EMPTY_LEDGER: LedgerState = {
  ledger: null,
  fromMs: null,
  error: '',
  disabled: false,
  loading: true,
};

/**
 * The ledger from `fromMs` to now. It loads again when a selection needs an
 * earlier start than the loaded span (a shorter one reuses what is loaded) or
 * when the clock has moved into an hour the snapshot does not reach. Null waits
 * (e.g. for the credentials that decide the span).
 */
export function useUsageLedger(fromMs: number | null, nowMs: number) {
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const [state, setState] = useState<LedgerState>(EMPTY_LEDGER);
  const requestRef = useRef(0);

  const load = useCallback(
    async (startMs: number) => {
      const requestId = ++requestRef.current;
      if (!connected) {
        setState({ ...EMPTY_LEDGER, loading: false });
        return;
      }
      setState((prev) => ({ ...prev, loading: true }));
      try {
        const ledger = await usageLedgerApi.getLedger(startMs, Date.now());
        if (requestId !== requestRef.current) return;
        setState({ ledger, fromMs: startMs, error: '', disabled: false, loading: false });
      } catch (reason: unknown) {
        if (requestId !== requestRef.current) return;
        setState({
          ledger: null,
          fromMs: null,
          error: reason instanceof Error ? reason.message : String(reason),
          disabled: (reason as { status?: number } | null)?.status === 409,
          loading: false,
        });
      }
    },
    [connected]
  );

  const loadedFromMs = state.fromMs;
  const loadedToMs = state.ledger?.toMs ?? null;
  const failed = state.error !== '';
  // Only a missing start dims the page; catching up with the clock refreshes quietly.
  const covered = fromMs !== null && loadedFromMs !== null && loadedFromMs <= fromMs;
  const needsReload =
    fromMs !== null &&
    ledgerNeedsReload(
      loadedFromMs === null || loadedToMs === null
        ? null
        : { startMs: loadedFromMs, endMs: loadedToMs },
      fromMs,
      nowMs
    );
  useEffect(() => {
    if (fromMs === null || failed || !needsReload) return;
    void load(fromMs);
  }, [failed, fromMs, load, needsReload]);

  useEffect(
    () => () => {
      requestRef.current += 1;
    },
    []
  );

  const reload = useCallback(async () => {
    if (fromMs !== null) await load(fromMs);
  }, [fromMs, load]);

  return { ...state, covered, reload };
}
