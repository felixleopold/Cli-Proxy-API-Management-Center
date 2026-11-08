/**
 * Usage & quota page: the header (with the global Claude API credit switch),
 * then one provider filter over the pooled forecast and reserve pool, the
 * account rows (each credential's live quota with its spend in its current
 * window), the quota window timeline and the spend history. This shell owns the
 * credential list; AccountsList renders the account rows; ClaudeCreditCard owns
 * its switch; UsageSections owns the ledger, the tabs, the section order and the
 * header refresh.
 *
 * Behaviour contracts kept from the quota page:
 * - existing providers load on click; Devin queries once when first visible, without polling;
 * - cacheGeneration session isolation + request-id dedup (see useQuotaBatchLoader);
 * - quota caches are pruned per provider after the file list changes (no deleted files linger);
 * - useHeaderRefresh has one slot: UsageSections registers it and reloads the file list too.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authFilesApi } from '@/services/api';
import { triggerHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { useRevealGroup } from '@/hooks/motion';
import { useAuthStore, useQuotaStore, useThemeStore } from '@/stores';
import type { AuthFileItem, ResolvedTheme } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { AccountSpendContext } from '@/features/usage/components/AccountSpend';
import { UsageSections } from '@/features/usage/UsageSections';
import { ClaudeCreditCard } from './components/ClaudeCreditCard';
import { QuotaHeader } from './components/QuotaHeader';
import { AccountsList } from './components/AccountsList';
import { QuotaForecast } from './components/QuotaForecast';
import { QuotaTimeline } from './components/QuotaTimeline';
import { ReservesStrip, type LenderReleaseState } from './components/ReservesStrip';
import { QUOTA_PAGE_SIZE, QUOTA_TAB_ORDER, type QuotaSortMode } from './constants';
import {
  canRefreshQuotaAfterList,
  classifyQuotaFiles,
  disabledAccountFiles,
  filterEntriesByTab,
  filterEntriesBySearch,
  paginate,
  sortQuotaEntries,
  type QuotaFileEntry,
} from './logic';
import {
  buildPools,
  cardReading,
  gatewayResetCredits,
  hasForecastCredentials,
  historyLookbackDays,
  type ForecastPastDays,
} from './quotaForecastModel';
import { nextRecoveryMs } from './resetSchedule';
import { QUOTA_ADAPTERS, getQuotaSetter, type QuotaCardState } from './providers';
import type { QuotaProviderType } from './providers/types';
import { useDevinQuotaAutoLoad } from './providers/devin/useDevinQuotaAutoLoad';
import { useQuotaActions } from './hooks/useQuotaActions';
import { useQuotaBatchLoader } from './hooks/useQuotaBatchLoader';
import { useQuotaHistory } from './hooks/useQuotaHistory';
import { splitPrivateCredentials, withoutPrivateHistory } from './privateCredentials';
import { isQuotaTabId, readQuotaUiState, writeQuotaUiState } from './uiState';
import styles from './UsageQuotaPage.module.scss';

/**
 * Existing providers display filenames; Devin's card and timeline share an
 * identity-aware display label. Keep the filename fallback stable for memoization.
 */
const displayNameFor = (name: string) => name;

export function UsageQuotaPage() {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);

  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [privateIds, setPrivateIds] = useState<ReadonlySet<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // 'all', a quota provider, or another provider with usage (only quota tabs persist).
  const [tab, setTab] = useState<string>(() => readQuotaUiState()?.tab ?? 'all');
  const [sortMode, setSortMode] = useState<QuotaSortMode>(
    () => readQuotaUiState()?.sortMode ?? 'default'
  );
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  // Entrance cascade for header + tabs (title → meta → action → tabs, 70ms apart)
  const revealRef = useRevealGroup<HTMLDivElement>();

  const disableControls = connectionStatus !== 'connected';

  /* ---------- 文件列表 ---------- */

  const sessionGeneration = useQuotaStore((state) => state.cacheGeneration);
  const [filesGeneration, setFilesGeneration] = useState<number | null>(null);
  const listRequestRef = useRef(0);
  const loadFiles = useCallback(async () => {
    const requestId = ++listRequestRef.current;
    if (connectionStatus !== 'connected') {
      setFiles([]);
      setFilesGeneration(null);
      setLoading(false);
      return;
    }
    const isCurrent = () =>
      requestId === listRequestRef.current &&
      sessionGeneration === useQuotaStore.getState().cacheGeneration;
    setLoading(true);
    setError('');
    try {
      const data = await authFilesApi.list();
      if (!isCurrent()) return;
      // Private credentials stay off this page entirely; Auth Files still lists them.
      const { shared, privateIds: hidden } = splitPrivateCredentials(data?.files || []);
      setFiles(shared);
      setPrivateIds(hidden);
      setFilesGeneration(sessionGeneration);
    } catch (err: unknown) {
      if (!isCurrent()) return;
      const message = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError(message);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [connectionStatus, sessionGeneration, t]);

  // A release covers every credential of the lender.
  const handleLenderRelease = useCallback((lender: string, release: LenderReleaseState) => {
    setFiles((current) =>
      current.map((file) =>
        file.lender === lender
          ? {
              ...file,
              lenderReserveOverrideUntilMs: release.untilMs ?? undefined,
              lenderReserveOverrideKeepPercent: release.keepPercent ?? undefined,
            }
          : file
      )
    );
  }, []);

  // One credential changed in place, e.g. by its row's enabled toggle.
  const handleFileChange = useCallback((key: string, patch: Partial<AuthFileItem>) => {
    setFiles((current) =>
      current.map((file) => (getQuotaCacheKey(file) === key ? { ...file, ...patch } : file))
    );
  }, []);

  useEffect(() => {
    void loadFiles();
    return () => {
      listRequestRef.current += 1;
    };
  }, [loadFiles]);

  /* ---------- 额度缓存 ----------
   * 排在归类/排序之前：「最快恢复优先」要读它算排序键。 */

  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const devinQuota = useQuotaStore((state) => state.devinQuota);
  const kimiQuota = useQuotaStore((state) => state.kimiQuota);
  const metaQuota = useQuotaStore((state) => state.metaQuota);
  const xaiQuota = useQuotaStore((state) => state.xaiQuota);

  const quotaByType = useMemo<Record<QuotaProviderType, Record<string, QuotaCardState>>>(
    () =>
      ({
        antigravity: antigravityQuota,
        claude: claudeQuota,
        codex: codexQuota,
        devin: devinQuota,
        kimi: kimiQuota,
        meta: metaQuota,
        xai: xaiQuota,
      }) as unknown as Record<QuotaProviderType, Record<string, QuotaCardState>>,
    [antigravityQuota, claudeQuota, codexQuota, devinQuota, kimiQuota, metaQuota, xaiQuota]
  );

  const getQuota = useCallback(
    (entry: QuotaFileEntry): QuotaCardState | undefined =>
      quotaByType[entry.type][getQuotaCacheKey(entry.file)],
    [quotaByType]
  );

  // A Codex card whose credits loaded has the freshest manual resets; otherwise the
  // gateway's cache is used, which also covers Claude reset grants.
  const resetCreditsFor = useCallback(
    (file: AuthFileItem) => {
      const card = codexQuota[getQuotaCacheKey(file)];
      return card?.status === 'success' && !card.rateLimitResetCreditsError
        ? card.rateLimitResetCredits
        : gatewayResetCredits(file);
    },
    [codexQuota]
  );

  /* ---------- 归类 / 过滤 / 排序 / 分页 ---------- */

  // 只在「最快恢复优先」下订阅分钟时钟。默认序下不门控的话，pageItems 每分钟
  // 换一次身份，会反复空转下面那个「刷新全部」的 loading 下降沿 effect。
  const tick = useNow(sortMode !== 'default');
  const sortNow = sortMode === 'default' ? 0 : tick;

  const entries = useMemo(() => classifyQuotaFiles(files), [files]);
  const disabledFiles = useMemo(
    () => disabledAccountFiles(files, tab, search),
    [files, tab, search]
  );
  // A provider without quota support has no cards.
  const filteredEntries = useMemo(
    () =>
      isQuotaTabId(tab) ? filterEntriesBySearch(filterEntriesByTab(entries, tab), search) : [],
    [entries, tab, search]
  );
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setPage(1);
  }, []);

  const resolveNextRecovery = useCallback(
    (entry: QuotaFileEntry) => nextRecoveryMs(entry.type, getQuota(entry), sortNow),
    [getQuota, sortNow]
  );
  // 排序在分页之前：否则「最快恢复」只在当前页内成立。
  const sortedEntries = useMemo(
    () => sortQuotaEntries(filteredEntries, sortMode, resolveNextRecovery),
    [filteredEntries, sortMode, resolveNextRecovery]
  );

  const { pageItems, currentPage, totalPages } = useMemo(
    () => paginate(sortedEntries, page, QUOTA_PAGE_SIZE),
    [sortedEntries, page]
  );

  const handleTabChange = useCallback((next: string) => {
    setTab(next);
    setPage(1);
    if (isQuotaTabId(next)) writeQuotaUiState({ tab: next });
  }, []);

  const handleSortModeChange = useCallback((next: string) => {
    setSortMode(next as QuotaSortMode);
    setPage(1);
    writeQuotaUiState({ sortMode: next as QuotaSortMode });
  }, []);

  // The forecast's past range decides how much history (and capacity timeline) loads.
  const [past, setPast] = useState<ForecastPastDays>(() => readQuotaUiState()?.forecastPast ?? 7);
  const choosePast = useCallback((next: ForecastPastDays) => {
    setPast(next);
    writeQuotaUiState({ forecastPast: next });
  }, []);
  // Shared by the forecast and the subscription cards (windows for credentials without live signals).
  const loadedHistory = useQuotaHistory(
    hasForecastCredentials(files),
    files,
    historyLookbackDays(past)
  );
  const history = useMemo(
    () => withoutPrivateHistory(loadedHistory, privateIds),
    [loadedHistory, privateIds]
  );

  /* ---------- Pools ----------
   * Shared by the forecast and the account rows: live signals, else the latest history
   * reading, else the loaded card. */

  const historySamples = history.status === 'ok' ? history.forecastSamples : null;
  const cardReadings = useMemo(
    () =>
      new Map(
        entries.flatMap((entry) => {
          const reading = cardReading(entry.type, getQuota(entry));
          return reading && typeof entry.file.id === 'string' ? [[entry.file.id, reading]] : [];
        })
      ),
    [entries, getQuota]
  );
  const pools = useMemo(
    () => buildPools(files, historySamples ?? [], cardReadings),
    [files, historySamples, cardReadings]
  );

  const { loadedCount, attentionCount } = useMemo(() => {
    let loaded = 0;
    let attention = 0;
    entries.forEach((entry) => {
      const status = quotaByType[entry.type][getQuotaCacheKey(entry.file)]?.status;
      if (status === 'success') loaded += 1;
      else if (status === 'error') attention += 1;
    });
    return { loadedCount: loaded, attentionCount: attention };
  }, [entries, quotaByType]);

  // 剪枝：文件列表落定后，各 provider 缓存只保留仍存在的凭证
  useEffect(() => {
    if (loading || error || filesGeneration !== sessionGeneration) return;
    const survivorsByType = new Map<QuotaProviderType, Set<string>>(
      QUOTA_TAB_ORDER.map((type) => [type, new Set<string>()])
    );
    entries.forEach((entry) => survivorsByType.get(entry.type)?.add(getQuotaCacheKey(entry.file)));

    QUOTA_TAB_ORDER.forEach((type) => {
      const survivors = survivorsByType.get(type) ?? new Set<string>();
      const setQuota = getQuotaSetter(QUOTA_ADAPTERS[type]);
      setQuota((prev) => {
        const staleKeys = Object.keys(prev).filter((name) => !survivors.has(name));
        if (staleKeys.length === 0) return prev;
        const next = { ...prev };
        staleKeys.forEach((name) => delete next[name]);
        return next;
      });
    });
  }, [entries, error, filesGeneration, loading, sessionGeneration]);

  /* ---------- 加载与操作 ---------- */

  const { batchLoading, loadQuota } = useQuotaBatchLoader();
  const { resettingQuotaName, refreshQuota, resetQuota } = useQuotaActions(disableControls);

  const pendingRefreshRef = useRef<number | null>(null);
  const prevLoadingRef = useRef(loading);

  // 刷新全部：先重取文件列表，待其落定（loading 下降沿）再批量拉当前页额度
  // The header refresh (registered by UsageSections) reloads the file list, ledger and labels,
  // so spend and estimates refresh together with the quota readings.
  const handleRefreshAll = useCallback(() => {
    if (disableControls) return;
    pendingRefreshRef.current = sessionGeneration;
    void triggerHeaderRefresh();
  }, [disableControls, sessionGeneration]);

  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = loading;

    const requestedSession = pendingRefreshRef.current;
    if (requestedSession === null) return;
    if (requestedSession !== sessionGeneration) {
      pendingRefreshRef.current = null;
      return;
    }
    if (loading || !wasLoading) return;

    pendingRefreshRef.current = null;
    if (
      canRefreshQuotaAfterList(
        requestedSession,
        sessionGeneration,
        filesGeneration,
        Boolean(error),
        disableControls
      )
    ) {
      void loadQuota(pageItems);
    }
  }, [disableControls, error, filesGeneration, loading, loadQuota, pageItems, sessionGeneration]);

  useDevinQuotaAutoLoad(
    pageItems,
    disableControls ||
      loading ||
      batchLoading ||
      Boolean(error) ||
      filesGeneration !== sessionGeneration,
    loadQuota
  );

  const canUseActions = !disableControls && !loading && filesGeneration === sessionGeneration;

  /* ---------- 渲染 ---------- */

  const renderAccounts = (spend: AccountSpendContext) => (
    <AccountsList
      spend={spend}
      files={files}
      entries={entries}
      disabledFiles={disabledFiles}
      filteredCount={filteredEntries.length}
      pageItems={pageItems}
      currentPage={currentPage}
      totalPages={totalPages}
      onPageChange={setPage}
      search={search}
      onSearchChange={handleSearchChange}
      sortMode={sortMode}
      onSortModeChange={handleSortModeChange}
      loading={loading}
      error={error}
      tab={tab}
      onTabChange={handleTabChange}
      getQuota={getQuota}
      pools={pools}
      cardReadings={cardReadings}
      canUseActions={canUseActions}
      resettingQuotaName={resettingQuotaName}
      onRefreshQuota={(entry) => void refreshQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
      onResetQuota={(entry) => resetQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
      onFileChange={handleFileChange}
      onReload={() => void loadFiles()}
      resolvedTheme={resolvedTheme}
    />
  );

  return (
    <div className={styles.page} ref={revealRef}>
      <QuotaHeader
        totalCount={entries.length}
        loadedCount={loadedCount}
        attentionCount={attentionCount}
        refreshing={loading || batchLoading}
        disableControls={disableControls}
        onRefreshAll={handleRefreshAll}
        // Global, so in the header above the provider tabs; hidden without the switch.
        extra={<ClaudeCreditCard />}
      />

      <UsageSections
        files={files}
        filesReady={!loading || files.length > 0}
        history={history}
        provider={tab}
        onProviderChange={handleTabChange}
        onRefresh={loadFiles}
        accounts={renderAccounts}
        forecast={
          <>
            {/* Lenders and their reserve releases; hidden without a lender reserve. */}
            <ReservesStrip
              files={files}
              pools={pools}
              cardReadings={cardReadings}
              onChange={handleLenderRelease}
              onReload={() => void loadFiles()}
            />
            {/* Pooled across every credential of the provider, independent of search and paging. */}
            <QuotaForecast
              files={files}
              history={history}
              tab={tab}
              past={past}
              onPastChange={choosePast}
              cardReadings={cardReadings}
              resetCreditsFor={resetCreditsFor}
            />
          </>
        }
        timeline={
          // Only the current page's credentials, so many credentials never build unbounded lanes.
          <QuotaTimeline
            entries={pageItems}
            quotaFor={getQuota}
            displayNameFor={displayNameFor}
            resolvedTheme={resolvedTheme}
          />
        }
      />
    </div>
  );
}
