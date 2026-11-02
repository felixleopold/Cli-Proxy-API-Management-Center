import { useCallback, useEffect, useRef, useState } from 'react';
import { usagePoolApi } from '@/services/api';
import { changeOverride, reportsFor, type ScopedPoolReports } from '../usagePoolModel';
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
  // Kept with the person they belong to; see reportsFor.
  const [loaded, setLoaded] = useState<ScopedPoolReports | null>(null);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const requestRef = useRef(0);
  // The selection now, for work that outlives the render that started it.
  const selectedRef = useRef(user);
  useEffect(() => {
    selectedRef.current = user;
  }, [user]);
  const providerKey = providers.join(',');

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    const list = providerKey ? providerKey.split(',') : [];
    if (!connected || list.length === 0) {
      setLoaded(null);
      return;
    }
    setLoading(true);
    try {
      const next = await Promise.all(list.map((provider) => usagePoolApi.getPool(provider, user)));
      if (requestId !== requestRef.current) return;
      setLoaded({ user, reports: next });
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

  /**
   * Turns target's override on for OVERRIDE_DURATION or off; rejects on failure.
   * Ignored unless target is the selected user (see overrideTarget).
   */
  const setOverride = useCallback(
    async (target: string, on: boolean) => {
      if (!target || target !== user) return;
      setSaving(true);
      try {
        await changeOverride(target, on, {
          set: (name, enable) =>
            enable
              ? usagePoolApi.setOverride(name, OVERRIDE_DURATION)
              : usagePoolApi.clearOverride(name),
          selected: () => selectedRef.current,
          refresh: load,
        });
      } finally {
        setSaving(false);
      }
    },
    [load, user]
  );

  return { reports: reportsFor(loaded, user), supported, loading, error, saving, setOverride };
}
