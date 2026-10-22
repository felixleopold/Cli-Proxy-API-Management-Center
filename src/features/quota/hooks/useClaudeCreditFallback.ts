import { useCallback, useEffect, useRef, useState } from 'react';
import { claudeCreditFallbackApi, type ClaudeCreditFallback } from '@/services/api';
import { useAuthStore } from '@/stores';
import { MINUTE_MS } from '@/utils/time/durations';

/**
 * The gateway's Claude API credit switch, refetched every minute while the tab
 * is visible and whenever it regains focus, so an automatic turn-off shows up.
 * Null while disconnected, before the first load, and on gateways without the
 * switch (404).
 */
export function useClaudeCreditFallback() {
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const [state, setState] = useState<ClaudeCreditFallback | null>(null);
  const [saving, setSaving] = useState(false);
  const requestRef = useRef(0);
  // Polls wait while a change is in flight, so a read sent before it cannot undo it.
  const savingRef = useRef(false);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (!connected) {
      setState(null);
      return;
    }
    try {
      const next = await claudeCreditFallbackApi.get();
      if (requestId === requestRef.current) setState(next);
    } catch (reason: unknown) {
      if (requestId !== requestRef.current) return;
      // Older gateways have no switch; other failures keep the last known state.
      if ((reason as { status?: number } | null)?.status === 404) setState(null);
    }
  }, [connected]);

  useEffect(() => {
    void load();
    const refresh = () => {
      if (document.visibilityState === 'visible' && !savingRef.current) void load();
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

  /** Rejects on failure; the caller reports it. */
  const setEnabled = useCallback(async (enabled: boolean) => {
    const requestId = ++requestRef.current;
    savingRef.current = true;
    setSaving(true);
    try {
      const next = await claudeCreditFallbackApi.setEnabled(enabled);
      if (requestId === requestRef.current) setState(next);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, []);

  return { state, saving, setEnabled };
}
