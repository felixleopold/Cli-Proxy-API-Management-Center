import { useCallback, useEffect, useRef, useState } from 'react';
import { usagePoolApi, type UsagePoolReport } from '@/services/api';
import { useAuthStore } from '@/stores';
import { MINUTE_MS } from '@/utils/time/durations';

/** How long an override from the panel lasts: one 5-hour window. */
export const OVERRIDE_DURATION = '5h';

/**
 * The gateway's pool report per provider, scoped to user when set, refetched
 * every minute while the tab is visible and on focus. `supported` turns false
 * on gateways without usage reserves (404), and the panel hides itself.
 */
export function useUsagePool(providers: string[], user: string) {
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const [reports, setReports] = useState<UsagePoolReport[]>([]);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const requestRef = useRef(0);
  const providerKey = providers.join(',');

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    const list = providerKey ? providerKey.split(',') : [];
    if (!connected || list.length === 0) {
      setReports([]);
      return;
    }
    setLoading(true);
    try {
      const next = await Promise.all(list.map((provider) => usagePoolApi.getPool(provider, user)));
      if (requestId !== requestRef.current) return;
      setReports(next);
      setSupported(true);
      setError(null);
    } catch (reason: unknown) {
      if (requestId !== requestRef.current) return;
      if ((reason as { status?: number } | null)?.status === 404) setSupported(false);
      else setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [connected, providerKey, user]);

  useEffect(() => {
    void load();
    const refresh = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const timer = window.setInterval(refresh, MINUTE_MS);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      requestRef.current += 1;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  /** Turns user's override on for OVERRIDE_DURATION or off; rejects on failure. */
  const setOverride = useCallback(
    async (on: boolean) => {
      if (!user) return;
      setSaving(true);
      try {
        if (on) await usagePoolApi.setOverride(user, OVERRIDE_DURATION);
        else await usagePoolApi.clearOverride(user);
      } finally {
        setSaving(false);
      }
      await load();
    },
    [load, user]
  );

  return { reports, supported, loading, error, saving, setOverride };
}
