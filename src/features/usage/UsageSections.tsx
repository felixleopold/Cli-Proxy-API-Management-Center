/**
 * The usage half of the Usage & quota page, in span order: current quota
 * windows (the pooled forecast plus each subscription's spend in its own
 * current window), then spend history (a 24h/7d/30d/90d range, or one
 * subscription's window, for the KPIs, chart and users table), then the quota
 * details slot and the client key → device/user labels. Each section states
 * the span its numbers cover. Logic lives in usageModel.ts.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconChevronLeft, IconChevronRight } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/Skeleton';
import { getAuthFileIcon } from '@/features/authFiles/constants';
import { ProviderTabs } from '@/features/authFiles/components/ProviderTabs';
import { providerLabel } from '@/features/dashboard/utils';
import { QUOTA_TAB_ORDER } from '@/features/quota/constants';
import type { QuotaHistoryState } from '@/features/quota/hooks/useQuotaHistory';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { useNotificationStore, useThemeStore } from '@/stores';
import type { AuthFileItem, UsageClient, UsageClientLabel } from '@/types';
import { formatCompactNumber, formatPercent, maskApiKey } from '@/utils/format';
import { formatRelativeInstant } from '@/utils/quota/relativeTime';
import { UsageClientsEditor } from './components/UsageClientsEditor';
import { UsageSpendChart, type ChartMarker, type ChartSeries } from './components/UsageSpendChart';
import { UsageSubscriptions } from './components/UsageSubscriptions';
import { UsageUsersTable } from './components/UsageUsersTable';
import { useUsageDirectory, useUsageLedger } from './hooks/useUsageData';
import {
  MAX_WINDOWS_BACK,
  OTHER_KEY,
  OWN_ACCOUNT_AUTH_ID,
  RANGES,
  buildClientRows,
  buildTimeBuckets,
  credentialKind,
  filterBuckets,
  formatUsd,
  ledgerStartMs,
  parseSubscription,
  resetMarkers,
  resolveSelection,
  rollupUsers,
  seriesKey,
  stackByTime,
  subscriptionSlots,
  sumCost,
  summarizeSubscription,
  userSlots,
  withHistoryWindow,
  type Selection,
  type SeriesSlot,
  type Subscription,
  type UsageRange,
} from './usageModel';
import styles from './UsageSections.module.scss';

type StackBy = 'user' | 'subscription';
const STACK_MODES: StackBy[] = ['user', 'subscription'];

const slotOrder = (slot: SeriesSlot) => (slot === 'other' ? 100 : slot === 'none' ? 101 : slot);

/** A window whose credential vanished (or lost its window) falls back to the range. */
const resolveOrRange = (
  request: Selection,
  range: UsageRange,
  subscriptions: readonly Subscription[],
  nowMs: number,
  snapshotMs?: number
) =>
  resolveSelection(request, subscriptions, nowMs, snapshotMs) ??
  resolveSelection({ kind: 'range', range }, subscriptions, nowMs, snapshotMs)!;

export interface UsageSectionsProps {
  /** Credentials, loaded by the page; their passive quota signals give the windows. */
  files: AuthFileItem[];
  /** The credential list has settled at least once. */
  filesReady: boolean;
  /** Quota history, for credentials without a live reading. */
  history: QuotaHistoryState;
  /** The page's provider filter: 'all' or a provider id. */
  provider: string;
  onProviderChange: (provider: string) => void;
  /** Reloads the page's credential list (the header refresh reloads both halves). */
  onRefresh: () => Promise<void>;
  /** The pooled remaining-quota forecast, shown with the current windows. */
  forecast: ReactNode;
  /** Per-credential quota cards and timeline, shown below the spend history. */
  quotaDetails: ReactNode;
}

export function UsageSections({
  files,
  filesReady,
  history,
  provider,
  onProviderChange,
  onRefresh,
  forecast,
  quotaDetails,
}: UsageSectionsProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const now = useNow();

  const [range, setRange] = useState<UsageRange>('7d');
  const [windowPick, setWindowPick] = useState<{ id: string; stepsBack: number } | null>(null);
  const [stackBy, setStackBy] = useState<StackBy>('user');

  const directory = useUsageDirectory();
  const samples = history.status === 'ok' ? history.samples : null;
  const subscriptions = useMemo(
    () =>
      files
        .filter((file) => !file.disabled)
        .map((file) => withHistoryWindow(parseSubscription(file), samples ?? [])),
    [files, samples]
  );

  const request = useMemo<Selection>(
    () =>
      windowPick
        ? { kind: 'window', subscriptionId: windowPick.id, stepsBack: windowPick.stepsBack }
        : { kind: 'range', range },
    [range, windowPick]
  );
  const ledgerState = useUsageLedger(
    filesReady
      ? ledgerStartMs(
          resolveOrRange(request, range, subscriptions, now),
          subscriptions,
          now,
          resolveOrRange({ kind: 'range', range }, range, subscriptions, now)
        )
      : null,
    now
  );
  const { ledger } = ledgerState;
  // The comparison stops where loaded data ends, not at a later clock.
  const snapshotMs = Math.min(now, ledger?.toMs ?? now);
  const selection = useMemo(
    () => resolveOrRange(request, range, subscriptions, now, snapshotMs),
    [now, range, request, snapshotMs, subscriptions]
  );
  // Credentials without a window show their spend over the range, whatever history shows.
  const rangeSelection = useMemo(
    () => resolveOrRange({ kind: 'range', range }, range, subscriptions, now, snapshotMs),
    [now, range, snapshotMs, subscriptions]
  );
  const windowSubscription =
    selection.authId === null
      ? undefined
      : subscriptions.find((subscription) => subscription.id === selection.authId);
  const picked = windowSubscription !== undefined;

  const reload = useCallback(async () => {
    await Promise.all([onRefresh(), directory.reload(), ledgerState.reload()]);
  }, [directory, ledgerState, onRefresh]);
  useHeaderRefresh(reload);

  // The clients endpoint is fresher than the ledger's copy (it reflects saves).
  const labels = useMemo<UsageClient[]>(() => {
    const merged = new Map((ledger?.clients ?? []).map((client) => [client.fingerprint, client]));
    directory.clients?.forEach((client) => merged.set(client.fingerprint, client));
    return Array.from(merged.values());
  }, [directory.clients, ledger]);
  const labelByFingerprint = useMemo(
    () => new Map(labels.map((client) => [client.fingerprint, client])),
    [labels]
  );

  const userColors = useMemo(() => userSlots(labels), [labels]);
  const subscriptionColors = useMemo(() => subscriptionSlots(subscriptions), [subscriptions]);
  const subscriptionById = useMemo(
    () => new Map(subscriptions.map((subscription) => [subscription.id, subscription])),
    [subscriptions]
  );

  const buckets = useMemo(() => ledger?.buckets ?? [], [ledger]);
  const providerFilter = picked ? null : provider === 'all' ? null : provider;
  const tabProvider = provider === 'all' ? null : provider;

  // Tabs: every quota provider, then any other provider with a credential or spend.
  const providerTabs = useMemo(() => {
    const counts: Record<string, number> = { all: subscriptions.length };
    for (const type of QUOTA_TAB_ORDER) counts[type] = 0;
    for (const subscription of subscriptions) {
      counts[subscription.provider] = (counts[subscription.provider] ?? 0) + 1;
    }
    for (const bucket of buckets) counts[bucket.provider.toLowerCase()] ??= 0;
    const quotaTypes = new Set<string>(QUOTA_TAB_ORDER);
    const others = Object.keys(counts)
      .filter((type) => type && type !== 'all' && !quotaTypes.has(type))
      .sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
    return { types: ['all', ...QUOTA_TAB_ORDER, ...others], counts };
  }, [buckets, subscriptions]);

  const selected = useMemo(
    () =>
      filterBuckets(buckets, {
        ...selection,
        provider: providerFilter,
        authId: selection.authId,
      }),
    [buckets, providerFilter, selection]
  );
  const previous = useMemo(
    () =>
      filterBuckets(buckets, {
        ...selection.previous,
        provider: providerFilter,
        authId: selection.authId,
      }),
    [buckets, providerFilter, selection]
  );
  const rollup = useMemo(() => rollupUsers(selected, labels), [labels, selected]);
  const previousCost = useMemo(() => sumCost(previous), [previous]);

  const userLabel = useCallback((user: string) => user || t('usage.unassigned'), [t]);
  const subscriptionLabel = useCallback(
    (id: string) => {
      const subscription = subscriptionById.get(id);
      switch (credentialKind(id, subscriptionById)) {
        case 'pre_tracking':
          return t('usage.auth_pre_tracking');
        case 'own_account':
          return t('usage.auth_own_account');
        case 'removed':
          return t('usage.removed_credential');
        default:
          return `${providerLabel(subscription!.provider, t('usage.unknown_provider'))} · ${subscription!.name}`;
      }
    },
    [subscriptionById, t]
  );

  // ---------- Chart ----------
  const stackMode: StackBy = picked ? 'user' : stackBy;
  const timeBuckets = useMemo(() => buildTimeBuckets(selection, selection.unit), [selection]);
  const stacked = useMemo(
    () =>
      stackByTime(selected, timeBuckets, (bucket) =>
        stackMode === 'user'
          ? seriesKey(userColors, labelByFingerprint.get(bucket.fingerprint)?.user ?? '')
          : seriesKey(subscriptionColors, bucket.authId)
      ),
    [labelByFingerprint, selected, stackMode, subscriptionColors, timeBuckets, userColors]
  );
  const series = useMemo<ChartSeries[]>(() => {
    const keys = new Set(stacked.flatMap((bucket) => Array.from(bucket.values.keys())));
    const colors = stackMode === 'user' ? userColors : subscriptionColors;
    return Array.from(keys)
      .map((key): ChartSeries => {
        if (key === OTHER_KEY) {
          return {
            key,
            slot: 'other',
            label: t(stackMode === 'user' ? 'usage.other_users' : 'usage.other_subscriptions'),
          };
        }
        return {
          key,
          slot: colors.get(key) ?? 'other',
          label: stackMode === 'user' ? userLabel(key) : subscriptionLabel(key),
        };
      })
      .sort((a, b) => slotOrder(a.slot) - slotOrder(b.slot));
  }, [stackMode, stacked, subscriptionColors, subscriptionLabel, t, userColors, userLabel]);

  // Resets only read as landmarks at hour and six-hour resolution.
  const markers = useMemo<ChartMarker[]>(() => {
    if (picked || (selection.unit !== 'hour' && selection.unit !== 'sixHours')) return [];
    const visible = subscriptions.filter(
      (subscription) => providerFilter === null || subscription.provider === providerFilter
    );
    return resetMarkers(visible, selection, now).map(({ atMs, subscription }) => ({
      atMs,
      label: subscriptionLabel(subscription.id),
      iconSrc: getAuthFileIcon(subscription.provider, resolvedTheme),
    }));
  }, [now, picked, providerFilter, resolvedTheme, selection, subscriptionLabel, subscriptions]);

  // ---------- Current windows ----------
  const summaries = useMemo(
    () =>
      subscriptions
        .filter((subscription) => tabProvider === null || subscription.provider === tabProvider)
        .map((subscription) =>
          summarizeSubscription(subscription, buckets, labels, now, rangeSelection)
        )
        .sort(
          (a, b) =>
            Number(Boolean(b.window)) - Number(Boolean(a.window)) ||
            a.subscription.provider.localeCompare(b.subscription.provider) ||
            b.costUsd - a.costUsd
        ),
    [buckets, labels, now, rangeSelection, subscriptions, tabProvider]
  );

  // Usage outside any subscription: shared pool before tracking, imported personal account.
  const outsideWindows = useMemo(() => {
    if (picked) return { preTrackingUsd: 0, ownAccountUsd: 0 };
    return {
      preTrackingUsd: sumCost(selected.filter((bucket) => !bucket.authId)),
      ownAccountUsd: sumCost(selected.filter((bucket) => bucket.authId === OWN_ACCOUNT_AUTH_ID)),
    };
  }, [picked, selected]);

  const clientRows = useMemo(
    () => buildClientRows(labels, directory.apiKeys),
    [directory.apiKeys, labels]
  );
  const keyHints = useMemo(
    () =>
      new Map(
        clientRows.flatMap((row) => (row.apiKey ? [[row.fingerprint, maskApiKey(row.apiKey)]] : []))
      ),
    [clientRows]
  );

  // ---------- Formatting ----------
  const formatDay = useCallback(
    (ms: number) => new Date(ms).toLocaleDateString(locale, { month: 'short', day: 'numeric' }),
    [locale]
  );
  const formatInstant = useCallback(
    (ms: number) =>
      new Date(ms).toLocaleString(locale, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    [locale]
  );
  // Windows start and end at a reset, so they show the time; ranges are whole days.
  const spanText = picked
    ? `${formatInstant(selection.startMs)} – ${formatInstant(selection.endMs)}`
    : `${formatDay(selection.startMs)} – ${formatDay(selection.endMs - 1)}`;
  const rangeSpanText = `${formatDay(rangeSelection.startMs)} – ${formatDay(rangeSelection.endMs - 1)}`;
  const inProgress = selection.endMs > now;

  const change = previousCost > 0 ? ((rollup.costUsd - previousCost) / previousCost) * 100 : null;
  const topUser = rollup.users.find((user) => user.user) ?? rollup.users[0];

  const selectWindow = (id: string) =>
    setWindowPick((pick) => (pick?.id === id ? null : { id, stepsBack: 0 }));
  const stepWindow = (delta: number) =>
    setWindowPick((pick) =>
      pick
        ? { ...pick, stepsBack: Math.min(MAX_WINDOWS_BACK, Math.max(0, pick.stepsBack + delta)) }
        : pick
    );

  const handleSave = async (next: UsageClientLabel[]) => {
    try {
      await directory.saveClients(next);
      showNotification(t('usage.clients_saved'), 'success');
    } catch (err: unknown) {
      showNotification(
        `${t('usage.clients_save_failed')}: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      );
      throw err;
    }
  };

  const windowProvider = windowSubscription
    ? providerLabel(windowSubscription.provider, t('usage.unknown_provider'))
    : '';
  const windowIcon = windowSubscription
    ? getAuthFileIcon(windowSubscription.provider, resolvedTheme)
    : null;
  const showSkeleton = !ledger && !ledgerState.error;
  const rangeLabel = (value: UsageRange) => t(`usage.range_${value}`);
  const rangeLong = t(`usage.range_long_${range}`);
  const stale = ledgerState.covered ? '' : styles.contentStale;

  return (
    <>
      <div className={styles.tabsRow} data-reveal>
        <ProviderTabs
          types={providerTabs.types}
          counts={providerTabs.counts}
          active={provider}
          resolvedTheme={resolvedTheme}
          onChange={(type) => {
            setWindowPick(null);
            onProviderChange(type);
          }}
        />
      </div>

      {/* ---------- Current quota windows: no range control; each card names its window. ---------- */}
      <section className={styles.section} aria-labelledby="usage-windows-title">
        <header className={styles.sectionHead}>
          <div className={styles.sectionCopy}>
            <h2 id="usage-windows-title" className={styles.sectionTitle}>
              {t('usage.windows_title')}
            </h2>
            <p className={styles.sectionHint}>{t('usage.windows_hint')}</p>
          </div>
        </header>

        {forecast}

        {ledgerState.error ? (
          <EmptyState
            title={t(ledgerState.disabled ? 'usage.disabled_title' : 'usage.load_failed_title')}
            description={t(
              ledgerState.disabled ? 'usage.disabled_desc' : 'usage.load_failed_desc',
              { error: ledgerState.error }
            )}
          />
        ) : showSkeleton ? (
          <Skeleton height={180} rounded={14} />
        ) : (
          <div className={stale} aria-busy={!ledgerState.covered}>
            <UsageSubscriptions
              summaries={summaries}
              userSlots={userColors}
              activeId={picked ? selection.authId : null}
              nowMs={now}
              resolvedTheme={resolvedTheme}
              userLabel={userLabel}
              rangeName={rangeLong}
              rangeSpan={rangeSpanText}
              onSelect={selectWindow}
            />
          </div>
        )}
      </section>

      {/* ---------- Spend history: the range control lives here and only affects this section. ---------- */}
      {!ledgerState.error && (
        <section className={styles.section} aria-labelledby="usage-history-title">
          <header className={styles.sectionHead}>
            <div className={styles.sectionCopy}>
              <h2 id="usage-history-title" className={styles.sectionTitle}>
                {t('usage.history_title')}
              </h2>
              <p className={styles.sectionSpan}>
                <span className={styles.spanStrong}>
                  {picked ? t('usage.history_window') : rangeLong}
                </span>
                <span className={styles.spanDot} aria-hidden="true">
                  ·
                </span>
                <span>{spanText}</span>
              </p>
            </div>
            <div className={styles.segmented} role="group" aria-label={t('usage.range_label')}>
              {RANGES.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={!picked && range === value}
                  aria-label={t(`usage.range_long_${value}`)}
                  onClick={() => {
                    setRange(value);
                    setWindowPick(null);
                  }}
                >
                  {rangeLabel(value)}
                </button>
              ))}
            </div>
          </header>

          {windowSubscription && (
            <div className={styles.windowBar} role="group" aria-label={t('usage.window_label')}>
              <div className={styles.windowStepper}>
                <button
                  type="button"
                  className={styles.chipButton}
                  aria-label={t('usage.window_previous')}
                  disabled={windowPick!.stepsBack >= MAX_WINDOWS_BACK}
                  onClick={() => stepWindow(1)}
                >
                  <IconChevronLeft size={14} />
                </button>
                <span className={styles.chipText}>
                  {windowIcon && <img src={windowIcon} alt="" className={styles.chipIcon} />}
                  <span className={styles.chipName}>
                    {windowProvider} · {windowSubscription.name}
                  </span>
                  <span className={styles.chipSpan}>
                    {inProgress
                      ? t('usage.window_resets', {
                          relative: formatRelativeInstant(selection.endMs, now, locale),
                        })
                      : t('usage.window_past')}
                  </span>
                </span>
                <button
                  type="button"
                  className={styles.chipButton}
                  aria-label={t('usage.window_next')}
                  disabled={windowPick!.stepsBack === 0}
                  onClick={() => stepWindow(-1)}
                >
                  <IconChevronRight size={14} />
                </button>
              </div>
              <button
                type="button"
                className={styles.windowBack}
                onClick={() => setWindowPick(null)}
              >
                {t('usage.window_clear', { range: rangeLabel(range) })}
              </button>
            </div>
          )}

          {showSkeleton ? (
            <div className={styles.skeletons} aria-hidden="true">
              <Skeleton height={92} rounded={14} />
              <Skeleton height={320} rounded={16} />
            </div>
          ) : (
            <div className={`${styles.content} ${stale}`} aria-busy={!ledgerState.covered}>
              <div className={styles.stats} role="group" aria-label={spanText}>
                <div className={styles.stat}>
                  <span className={styles.statLabel}>
                    {picked
                      ? inProgress
                        ? t('usage.stat_spend_window')
                        : t('usage.stat_spend_span', { span: spanText })
                      : t('usage.stat_spend_range', { range: rangeLabel(range) })}
                  </span>
                  <span className={styles.statValue}>{formatUsd(rollup.costUsd, locale)}</span>
                  <span className={styles.statHint}>{t('usage.stat_spend_hint')}</span>
                </div>
                <div className={styles.stat}>
                  <span className={styles.statLabel}>
                    {picked
                      ? inProgress
                        ? t('usage.stat_change_window_pace')
                        : t('usage.stat_change_window')
                      : t('usage.stat_change_range', { range: rangeLabel(range) })}
                  </span>
                  <span className={styles.statValue}>
                    {change === null
                      ? '—'
                      : `${change > 0 ? '+' : change < 0 ? '−' : ''}${formatPercent(Math.abs(change), 0)}`}
                  </span>
                  <span className={styles.statHint}>
                    {previousCost > 0
                      ? t('usage.stat_change_hint', { amount: formatUsd(previousCost, locale) })
                      : t('usage.stat_change_none')}
                  </span>
                </div>
                <div className={styles.stat}>
                  <span className={styles.statLabel}>{t('usage.stat_top_user')}</span>
                  <span className={`${styles.statValue} ${styles.statName}`}>
                    {topUser ? userLabel(topUser.user) : '—'}
                  </span>
                  <span className={styles.statHint}>
                    {topUser && rollup.costUsd > 0
                      ? t('usage.stat_top_user_hint', {
                          share: formatPercent((topUser.costUsd / rollup.costUsd) * 100, 0),
                          count: rollup.users.filter((user) => user.user).length,
                        })
                      : t('usage.selection_empty')}
                  </span>
                </div>
                <div className={styles.stat}>
                  <span className={styles.statLabel}>{t('usage.stat_requests')}</span>
                  <span className={styles.statValue}>{rollup.requests.toLocaleString(locale)}</span>
                  <span className={styles.statHint}>
                    {t('usage.stat_tokens_hint', { tokens: formatCompactNumber(rollup.tokens) })}
                  </span>
                </div>
              </div>

              <section className={styles.panel}>
                <header className={styles.panelHead}>
                  <div>
                    <h3 className={styles.panelTitle}>{t('usage.chart_title')}</h3>
                    <p className={styles.panelHint}>{t(`usage.chart_hint_${selection.unit}`)}</p>
                  </div>
                  {!picked && (
                    <div
                      className={`${styles.segmented} ${styles.segmentedSmall}`}
                      role="group"
                      aria-label={t('usage.stack_label')}
                    >
                      {STACK_MODES.map((value) => (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={stackBy === value}
                          onClick={() => setStackBy(value)}
                        >
                          {t(`usage.stack_${value}`)}
                        </button>
                      ))}
                    </div>
                  )}
                </header>
                <UsageSpendChart
                  stacked={stacked}
                  series={series}
                  span={selection}
                  unit={selection.unit}
                  nowMs={now}
                  showFuture={picked && inProgress}
                  markers={markers}
                  summary={t('usage.chart_summary', {
                    span: spanText,
                    total: formatUsd(rollup.costUsd, locale),
                  })}
                />
                {outsideWindows.preTrackingUsd > 0 && (
                  <p className={styles.note}>
                    {t('usage.pre_tracking_note', {
                      amount: formatUsd(outsideWindows.preTrackingUsd, locale),
                    })}
                  </p>
                )}
                {outsideWindows.ownAccountUsd > 0 && (
                  <p className={styles.note}>
                    {t('usage.own_account_note', {
                      amount: formatUsd(outsideWindows.ownAccountUsd, locale),
                    })}
                  </p>
                )}
              </section>

              <section className={styles.panel}>
                <header className={styles.panelHead}>
                  <div>
                    <h3 className={styles.panelTitle}>{t('usage.users_title')}</h3>
                    <p className={styles.panelHint}>{spanText}</p>
                  </div>
                </header>
                <UsageUsersTable
                  key={`${selection.startMs}-${providerFilter}-${selection.authId}`}
                  rollup={rollup}
                  slots={userColors}
                  userLabel={userLabel}
                  keyHints={keyHints}
                />
                {ledger && ledger.unpricedModels.length > 0 && (
                  <p className={styles.note}>
                    {t('usage.unpriced_note', { models: ledger.unpricedModels.join(', ') })}
                  </p>
                )}
              </section>
            </div>
          )}
        </section>
      )}

      <section className={styles.section} aria-labelledby="quota-details-title">
        <header className={styles.sectionHead}>
          <div className={styles.sectionCopy}>
            <h2 id="quota-details-title" className={styles.sectionTitle}>
              {t('quota_management.details_title')}
            </h2>
            <p className={styles.sectionHint}>{t('quota_management.details_hint')}</p>
          </div>
        </header>
        {quotaDetails}
      </section>

      {!ledgerState.error && !showSkeleton && (
        <section className={styles.panel}>
          <header className={styles.panelHead}>
            <div>
              <h2 className={styles.panelTitle}>{t('usage.clients_title')}</h2>
              <p className={styles.panelHint}>{t('usage.clients_hint')}</p>
            </div>
          </header>
          <UsageClientsEditor
            rows={clientRows}
            disabled={!directory.loaded || directory.clients === null}
            onSave={handleSave}
          />
        </section>
      )}
    </>
  );
}
