import { useEffect, useMemo, useRef, useState } from 'react';
import { authFilesApi } from '@/services/api';
import { useAuthStore, useQuotaStore } from '@/stores';
import { classifyQuotaFiles } from '@/features/quota/logic';
import { useQuotaBatchLoader } from '@/features/quota/hooks/useQuotaBatchLoader';
import { claudeSevenDayResets } from '../usageModel';

/**
 * Claude seven-day reset instants from the shared quota cache. When nothing is
 * cached yet, Claude quotas are fetched once per visit (as the Quota page would),
 * which also fills that page's cache.
 */
export function useClaudeWeekResets(enabled: boolean) {
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const resets = useMemo(() => claudeSevenDayResets(claudeQuota), [claudeQuota]);
  const { batchLoading, loadQuota } = useQuotaBatchLoader();
  const attempted = useRef(false);
  const [listing, setListing] = useState(false);

  useEffect(() => {
    if (!enabled || !connected || attempted.current || resets.length > 0) return;
    attempted.current = true;
    setListing(true);
    authFilesApi
      .list()
      .then((data) => {
        const targets = classifyQuotaFiles(data?.files ?? []).filter(
          (entry) => entry.type === 'claude'
        );
        return loadQuota(targets);
      })
      .catch(() => undefined)
      .finally(() => setListing(false));
  }, [connected, enabled, loadQuota, resets.length]);

  return { resets, loading: listing || batchLoading };
}
