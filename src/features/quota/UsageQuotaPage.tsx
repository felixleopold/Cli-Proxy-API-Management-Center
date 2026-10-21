/**
 * Usage & quota page: one provider filter over the current quota windows
 * (pooled forecast and subscription spend), the spend history, and the
 * per-credential quota cards. This shell owns the credential list and the
 * quota cards; UsageSections owns the ledger, the tabs and the header refresh.
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
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconSearch, IconX } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useNow } from '@/hooks/useNow';
import { useRevealGroup } from '@/hooks/motion';
import { useAuthStore, useQuotaStore, useThemeStore } from '@/stores';
import type { AuthFileItem, ResolvedTheme } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { UsageSections } from '@/features/usage/UsageSections';
import { QuotaHeader } from './components/QuotaHeader';
import { QuotaCard } from './components/QuotaCard';
import { QuotaForecast } from './components/QuotaForecast';
import { QuotaTimeline } from './components/QuotaTimeline';
import {
  CARD_ENTRANCE_BUDGET_MS,
  QUOTA_PAGE_SIZE,
  QUOTA_SORT_MODES,
  QUOTA_TAB_ORDER,
  type QuotaSortMode,
} from './constants';
import {
  canRefreshQuotaAfterList,
  classifyQuotaFiles,
  filterEntriesByTab,
  filterEntriesBySearch,
  paginate,
  sortQuotaEntries,
  type QuotaFileEntry,
} from './logic';
import { hasForecastCredentials } from './quotaForecastModel';
import { nextRecoveryMs } from './resetSchedule';
import { QUOTA_ADAPTERS, getQuotaSetter, type QuotaCardState } from './providers';
import type { QuotaProviderType } from './providers/types';
import { useDevinQuotaAutoLoad } from './providers/devin/useDevinQuotaAutoLoad';
import { useQuotaActions } from './hooks/useQuotaActions';
import { useQuotaBatchLoader } from './hooks/useQuotaBatchLoader';
import { useQuotaHistory } from './hooks/useQuotaHistory';
import { isQuotaTabId, readQuotaUiState, writeQuotaUiState } from './uiState';
import styles from './UsageQuotaPage.module.scss';

const SKELETON_CARD_COUNT = 6;

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // 'all', a quota provider, or another provider with usage (only quota tabs persist).
  const [tab, setTab] = useState<string>(() => readQuotaUiState()?.tab ?? 'all');
  const [sortMode, setSortMode] = useState<QuotaSortMode>(
    () => readQuotaUiState()?.sortMode ?? 'default'
  );
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
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
      setFiles(data?.files || []);
      setFilesGeneration(sessionGeneration);
    } catch (err: unknown) {
      if (!isCurrent()) return;
      const message = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError(message);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [connectionStatus, sessionGeneration, t]);

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

  // Manual resets only reach the store once a Codex card's quota has loaded.
  const resetCreditsFor = useCallback(
    (file: AuthFileItem) => codexQuota[getQuotaCacheKey(file)]?.rateLimitResetCredits,
    [codexQuota]
  );

  /* ---------- 归类 / 过滤 / 排序 / 分页 ---------- */

  // 只在「最快恢复优先」下订阅分钟时钟。默认序下不门控的话，pageItems 每分钟
  // 换一次身份，会反复空转下面那个「刷新全部」的 loading 下降沿 effect。
  const tick = useNow(sortMode !== 'default');
  const sortNow = sortMode === 'default' ? 0 : tick;

  const entries = useMemo(() => classifyQuotaFiles(files), [files]);
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

  const sortOptions = useMemo(
    () =>
      QUOTA_SORT_MODES.map((mode) => ({ value: mode, label: t(`quota_management.sort_${mode}`) })),
    [t]
  );

  // Shared by the forecast and the subscription cards (windows for credentials without live signals).
  const history = useQuotaHistory(hasForecastCredentials(files), files);

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
  const handleRefreshAll = useCallback(() => {
    if (disableControls) return;
    pendingRefreshRef.current = sessionGeneration;
    void loadFiles();
  }, [disableControls, loadFiles, sessionGeneration]);

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

  /* ---------- 首屏卡片一次性级联入场 ----------
   * 首批数据渲染后立即翻转 cardsAnimated；已挂载的卡片在挂载时捕获过自己的
   * 延迟（QuotaCard 内 useState 初始化），后续切 tab/翻页/刷新新挂载的卡片
   * 拿到 null —— 不重播。 */

  const [cardsAnimated, setCardsAnimated] = useState(false);
  const enableCardEntrance = !cardsAnimated && !loading && pageItems.length > 0;
  useEffect(() => {
    if (enableCardEntrance) {
      setCardsAnimated(true);
    }
  }, [enableCardEntrance]);
  const cardEntranceDelay = (index: number): number | null => {
    if (!enableCardEntrance) return null;
    if (pageItems.length <= 1) return 0;
    return Math.round((index / (pageItems.length - 1)) * CARD_ENTRANCE_BUDGET_MS);
  };

  /* ---------- 渲染 ---------- */

  const isEmpty = !loading && filteredEntries.length === 0;
  const quotaTab = isQuotaTabId(tab) && tab !== 'all' ? tab : null;

  const quotaDetails = (
    <>
      <div className={styles.toolbar}>
        <div className={styles.search}>
          <IconSearch size={16} className={styles.searchIcon} aria-hidden="true" />
          <input
            ref={searchInputRef}
            className={styles.searchInput}
            type="search"
            value={search}
            onChange={(event) => handleSearchChange(event.target.value)}
            placeholder={t('quota_management.search_placeholder')}
            aria-label={t('quota_management.search_label')}
          />
          {search && (
            <button
              type="button"
              className={styles.clearSearch}
              aria-label={t('quota_management.search_clear')}
              title={t('quota_management.search_clear')}
              onClick={() => {
                handleSearchChange('');
                searchInputRef.current?.focus();
              }}
            >
              <IconX size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className={styles.sort}>
          <Select
            value={sortMode}
            options={sortOptions}
            onChange={handleSortModeChange}
            ariaLabel={t('quota_management.sort_label')}
            size="sm"
          />
        </div>
      </div>

      {error && (
        <div className={styles.errorBanner} role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <div className={styles.grid} aria-hidden="true">
          {Array.from({ length: SKELETON_CARD_COUNT }, (_, index) => (
            <Skeleton key={index} height={168} rounded={14} />
          ))}
        </div>
      ) : isEmpty ? (
        <EmptyState
          title={
            search.trim()
              ? t('quota_management.search_empty_title')
              : quotaTab
                ? t(`${QUOTA_ADAPTERS[quotaTab].i18nPrefix}.empty_title`)
                : t('quota_management.empty_title')
          }
          description={
            search.trim()
              ? t('quota_management.search_empty_desc')
              : quotaTab
                ? t(`${QUOTA_ADAPTERS[quotaTab].i18nPrefix}.empty_desc`)
                : t('quota_management.empty_desc')
          }
          action={
            search.trim() ? (
              <Button variant="secondary" size="sm" onClick={() => handleSearchChange('')}>
                {t('quota_management.search_clear')}
              </Button>
            ) : tab === 'all' ? undefined : (
              <Button variant="secondary" size="sm" onClick={() => handleTabChange('all')}>
                {t('auth_files.filter_all')}
              </Button>
            )
          }
        />
      ) : (
        <div className={styles.grid}>
          {pageItems.map((entry, index) => (
            <QuotaCard
              key={`${entry.type}:${getQuotaCacheKey(entry.file)}`}
              entry={entry}
              quota={getQuota(entry)}
              resolvedTheme={resolvedTheme}
              canRefresh={canUseActions && !entry.file.disabled}
              resetting={resettingQuotaName === getQuotaCacheKey(entry.file)}
              entranceDelayMs={cardEntranceDelay(index)}
              onRefresh={() => void refreshQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
              onReset={() => resetQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
            />
          ))}
        </div>
      )}

      {!loading && filteredEntries.length > QUOTA_PAGE_SIZE && (
        <div className={styles.pagination}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPage(Math.max(1, currentPage - 1))}
            disabled={currentPage <= 1}
          >
            {t('auth_files.pagination_prev')}
          </Button>
          <div className={styles.pageInfo}>
            {t('auth_files.pagination_info', {
              current: currentPage,
              total: totalPages,
              count: filteredEntries.length,
            })}
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
            disabled={currentPage >= totalPages}
          >
            {t('auth_files.pagination_next')}
          </Button>
        </div>
      )}

      {/* 时间线只比较当前页凭证，避免大量凭证一次性生成无界泳道。 */}
      <QuotaTimeline
        entries={pageItems}
        quotaFor={getQuota}
        displayNameFor={displayNameFor}
        resolvedTheme={resolvedTheme}
      />
    </>
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
      />

      <UsageSections
        files={files}
        filesReady={!loading || files.length > 0}
        history={history}
        provider={tab}
        onProviderChange={handleTabChange}
        onRefresh={loadFiles}
        forecast={
          // Pooled across every credential of the provider, independent of search and paging.
          <QuotaForecast
            files={files}
            history={history}
            tab={tab}
            resetCreditsFor={resetCreditsFor}
          />
        }
        quotaDetails={quotaDetails}
      />
    </div>
  );
}
