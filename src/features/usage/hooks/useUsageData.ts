import { useCallback, useEffect, useRef, useState } from 'react';
import { apiKeysApi, authFilesApi, usageLedgerApi } from '@/services/api';
import { useAuthStore } from '@/stores';
import type { AuthFileItem, UsageClient, UsageClientLabel, UsageLedger } from '@/types';

interface Directory {
  /** Labels from the clients endpoint; null when it failed (the ledger's copy is used). */
  clients: UsageClient[] | null;
  apiKeys: string[];
  /** Credentials with their passive quota signals; [] when the listing failed. */
  credentials: AuthFileItem[];
  loaded: boolean;
}

const EMPTY_DIRECTORY: Directory = { clients: null, apiKeys: [], credentials: [], loaded: false };

/** Client labels, configured keys (for key hints) and credentials (for quota windows). */
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
    const [clients, apiKeys, credentials] = await Promise.allSettled([
      usageLedgerApi.getClients(),
      apiKeysApi.list(),
      authFilesApi.list(),
    ]);
    if (requestId !== requestRef.current) return;
    setDirectory({
      clients: clients.status === 'fulfilled' ? clients.value : null,
      apiKeys: apiKeys.status === 'fulfilled' ? apiKeys.value : [],
      credentials: credentials.status === 'fulfilled' ? (credentials.value?.files ?? []) : [],
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
 * The ledger from `fromMs` to now. It loads again only when a selection needs an
 * earlier start than the loaded span; a shorter one reuses what is loaded. Null
 * waits (e.g. for the credentials that decide the span).
 */
export function useUsageLedger(fromMs: number | null) {
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
  const failed = state.error !== '';
  const covered = fromMs !== null && loadedFromMs !== null && loadedFromMs <= fromMs;
  useEffect(() => {
    if (fromMs === null || failed || covered) return;
    void load(fromMs);
  }, [covered, failed, fromMs, load]);

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
