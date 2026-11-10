/**
 * The accounts section of the Usage & quota page: search and sort, then one
 * compact row per credential (quota rows of the current page, then spend-only
 * rows on the last page), then paging. The page owns the list, its filtering
 * and paging (the timeline and batch refresh read the same page); this renders.
 */

import { useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconSearch, IconX } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { useNow } from '@/hooks/useNow';
import type { AuthFileItem, ResolvedTheme } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { AccountSpendContext } from '@/features/usage/components/AccountSpend';
import { pairAccountSpend, pooledByAuthId, windowsForFile } from '../accountCards';
import { QUOTA_PAGE_SIZE, QUOTA_SORT_MODES, type QuotaSortMode } from '../constants';
import type { QuotaFileEntry } from '../logic';
import type { CardReading, ProviderPool } from '../quotaForecastModel';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import { isQuotaTabId } from '../uiState';
import { AccountStatusLockContext, useAccountStatusLockState } from './accountStatusLock';
import { DisabledAccountRow, QuotaAccountRow, SpendAccountRow } from './QuotaAccountRow';
import styles from './Accounts.module.scss';

const SKELETON_ROW_COUNT = 6;

export interface AccountsListProps {
  spend: AccountSpendContext;
  files: AuthFileItem[];
  /** Every quota entry before search and paging, so spend never pairs twice. */
  entries: QuotaFileEntry[];
  /** Disabled credentials of the tab and search: rows to re-enable, without quota. */
  disabledFiles: AuthFileItem[];
  filteredCount: number;
  pageItems: QuotaFileEntry[];
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  search: string;
  onSearchChange: (value: string) => void;
  sortMode: QuotaSortMode;
  onSortModeChange: (value: string) => void;
  loading: boolean;
  error: string;
  tab: string;
  onTabChange: (tab: string) => void;
  getQuota: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  pools: ProviderPool[];
  cardReadings: ReadonlyMap<string, CardReading>;
  canUseActions: boolean;
  resettingQuotaName: string | null;
  onRefreshQuota: (entry: QuotaFileEntry) => void;
  onResetQuota: (entry: QuotaFileEntry) => void;
  /** Patches one listed credential by its quota cache key (e.g. the enabled toggle). */
  onFileChange: (key: string, patch: Partial<AuthFileItem>) => void;
  /** Reloads the credential list after a settings save. */
  onReload: () => void;
  resolvedTheme: ResolvedTheme;
}

export function AccountsList(props: AccountsListProps) {
  const {
    spend,
    files,
    entries,
    disabledFiles,
    filteredCount,
    pageItems,
    currentPage,
    totalPages,
    onPageChange,
    search,
    onSearchChange,
    sortMode,
    onSortModeChange,
    loading,
    error,
    tab,
    onTabChange,
    getQuota,
    pools,
    cardReadings,
    canUseActions,
    resettingQuotaName,
    onRefreshQuota,
    onResetQuota,
    onFileChange,
    onReload,
    resolvedTheme,
  } = props;
  const { t } = useTranslation();
  const now = useNow();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const statusLock = useAccountStatusLockState();

  const sortOptions = useMemo(
    () =>
      QUOTA_SORT_MODES.map((mode) => ({ value: mode, label: t(`quota_management.sort_${mode}`) })),
    [t]
  );
  const pooledById = useMemo(() => pooledByAuthId(pools), [pools]);

  const { spendFor, spendOnly, fileFor } = pairAccountSpend(
    entries,
    spend.summaries,
    search,
    files
  );
  // Credentials without quota support follow the quota rows, on the last page.
  const spendOnlyRows =
    spend.status === 'unavailable' || currentPage !== totalPages ? [] : spendOnly;
  // A reload (refresh all, a settings save) keeps the rows; skeletons only before the first list.
  const firstLoad = loading && files.length === 0;
  // Disabled credentials come last, on the last page.
  const disabledRows = currentPage === totalPages ? disabledFiles : [];
  const isEmpty =
    !loading && filteredCount === 0 && spendOnlyRows.length === 0 && disabledRows.length === 0;
  const quotaTab = isQuotaTabId(tab) && tab !== 'all' ? QUOTA_ADAPTERS[tab] : null;

  const windowsFor = (entry: QuotaFileEntry) =>
    windowsForFile(entry.file, pooledById, cardReadings, now);

  return (
    <>
      <div className={styles.toolbar}>
        <div className={styles.search}>
          <IconSearch size={16} className={styles.searchIcon} aria-hidden="true" />
          <input
            ref={searchInputRef}
            className={styles.searchInput}
            type="search"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
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
                onSearchChange('');
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
            onChange={onSortModeChange}
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

      {firstLoad ? (
        <div className={styles.list} aria-hidden="true">
          {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
            <div key={index} className={styles.skeletonRow} />
          ))}
        </div>
      ) : isEmpty ? (
        <EmptyState
          title={
            search.trim()
              ? t('quota_management.search_empty_title')
              : quotaTab
                ? t(`${quotaTab.i18nPrefix}.empty_title`)
                : t('quota_management.empty_title')
          }
          description={
            search.trim()
              ? t('quota_management.search_empty_desc')
              : quotaTab
                ? t(`${quotaTab.i18nPrefix}.empty_desc`)
                : t('quota_management.empty_desc')
          }
          action={
            search.trim() ? (
              <Button variant="secondary" size="sm" onClick={() => onSearchChange('')}>
                {t('quota_management.search_clear')}
              </Button>
            ) : tab === 'all' ? undefined : (
              <Button variant="secondary" size="sm" onClick={() => onTabChange('all')}>
                {t('auth_files.filter_all')}
              </Button>
            )
          }
        />
      ) : (
        <AccountStatusLockContext.Provider value={statusLock}>
          <div className={styles.list}>
            <div className={styles.table}>
              <div className={styles.head} aria-hidden="true">
                <span />
                <span>{t('usage_accounts.col_account')}</span>
                <span title={t('usage_accounts.col_plan_hint')}>
                  {t('usage_accounts.col_plan')}
                </span>
                <span>{t('usage_accounts.col_five_hour')}</span>
                <span>{t('usage_accounts.col_weekly')}</span>
                <span>{t('usage_accounts.col_spend')}</span>
                <span>{t('usage_accounts.col_users')}</span>
                <span>{t('usage_accounts.col_pace')}</span>
                <span />
              </div>
              <ul className={styles.rows} aria-label={t('usage_accounts.list_label')}>
                {pageItems.map((entry) => (
                  <QuotaAccountRow
                    key={`${entry.type}:${getQuotaCacheKey(entry.file)}`}
                    entry={entry}
                    quota={getQuota(entry)}
                    windows={windowsFor(entry)}
                    summary={spendFor(entry)}
                    spend={spend}
                    resolvedTheme={resolvedTheme}
                    canRefresh={canUseActions && !entry.file.disabled}
                    resetting={resettingQuotaName === getQuotaCacheKey(entry.file)}
                    onRefresh={() => onRefreshQuota(entry)}
                    onReset={() => onResetQuota(entry)}
                    onFileChange={onFileChange}
                    onSettingsSaved={onReload}
                  />
                ))}
                {spendOnlyRows.map((summary) => (
                  <SpendAccountRow
                    key={`spend:${summary.subscription.id}`}
                    summary={summary}
                    file={fileFor(summary)}
                    spend={spend}
                    resolvedTheme={resolvedTheme}
                    onFileChange={onFileChange}
                    onSettingsSaved={onReload}
                  />
                ))}
                {disabledRows.map((file) => (
                  <DisabledAccountRow
                    key={`disabled:${getQuotaCacheKey(file)}`}
                    file={file}
                    spend={spend}
                    resolvedTheme={resolvedTheme}
                    onFileChange={onFileChange}
                    onSettingsSaved={onReload}
                  />
                ))}
              </ul>
            </div>
          </div>
        </AccountStatusLockContext.Provider>
      )}

      {!loading && filteredCount > QUOTA_PAGE_SIZE && (
        <div className={styles.pagination}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onPageChange(Math.max(1, currentPage - 1))}
            disabled={currentPage <= 1}
          >
            {t('auth_files.pagination_prev')}
          </Button>
          <div className={styles.pageInfo}>
            {t('auth_files.pagination_info', {
              current: currentPage,
              total: totalPages,
              count: filteredCount,
            })}
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
            disabled={currentPage >= totalPages}
          >
            {t('auth_files.pagination_next')}
          </Button>
        </div>
      )}
    </>
  );
}
