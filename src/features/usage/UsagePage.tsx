/**
 * Usage: API-equivalent USD by user across providers, for a rolling range or
 * one subscription's quota window, with subscription cards, a spend chart,
 * device/model drill-down and the client key → device/user labels. Logic lives
 * in usageModel.ts.
 */

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconChevronLeft, IconChevronRight, IconX } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/Skeleton';
import { getAuthFileIcon } from '@/features/authFiles/constants';
import { ProviderTabs } from '@/features/authFiles/components/ProviderTabs';
import { providerLabel } from '@/features/dashboard/utils';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useRevealGroup } from '@/hooks/motion';
import { useNow } from '@/hooks/useNow';
import { useNotificationStore, useThemeStore } from '@/stores';
import type { UsageClient, UsageClientLabel } from '@/types';
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
  RANGES,
  buildClientRows,
  buildTimeBuckets,
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
  type Selection,
  type SeriesSlot,
  type Subscription,
  type UsageRange,
} from './usageModel';
import styles from './UsagePage.module.scss';

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

export function UsagePage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const revealRef = useRevealGroup<HTMLDivElement>();
  const now = useNow();

  const [range, setRange] = useState<UsageRange>('7d');
  const [windowPick, setWindowPick] = useState<{ id: string; stepsBack: number } | null>(null);
  const [provider, setProvider] = useState('all');
  const [stackBy, setStackBy] = useState<StackBy>('user');

  const directory = useUsageDirectory();
  const subscriptions = useMemo(
    () => directory.credentials.filter((file) => !file.disabled).map(parseSubscription),
    [directory.credentials]
  );

  const request = useMemo<Selection>(
    () =>
      windowPick
        ? { kind: 'window', subscriptionId: windowPick.id, stepsBack: windowPick.stepsBack }
        : { kind: 'range', range },
    [range, windowPick]
  );
  const ledgerState = useUsageLedger(
    directory.loaded
      ? ledgerStartMs(resolveOrRange(request, range, subscriptions, now), subscriptions, now)
      : null
  );
  const { ledger } = ledgerState;
  // The comparison stops where loaded data ends, not at a later clock.
  const snapshotMs = Math.min(now, ledger?.toMs ?? now);
  const selection = useMemo(
    () => resolveOrRange(request, range, subscriptions, now, snapshotMs),
    [now, range, request, snapshotMs, subscriptions]
  );
  const windowSubscription =
    selection.authId === null
      ? undefined
      : subscriptions.find((subscription) => subscription.id === selection.authId);
  const picked = windowSubscription !== undefined;

  const reload = useCallback(async () => {
    await Promise.all([directory.reload(), ledgerState.reload()]);
  }, [directory, ledgerState]);
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

  // Tabs: every provider with a credential or with spend in the loaded span.
  const providerTabs = useMemo(() => {
    const counts: Record<string, number> = { all: subscriptions.length };
    for (const subscription of subscriptions) {
      counts[subscription.provider] = (counts[subscription.provider] ?? 0) + 1;
    }
    for (const bucket of buckets) counts[bucket.provider.toLowerCase()] ??= 0;
    const types = Object.keys(counts)
      .filter((type) => type && type !== 'all')
      .sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
    return { types: ['all', ...types], counts };
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
      if (!id) return t('usage.unattributed');
      const subscription = subscriptionById.get(id);
      return subscription
        ? `${providerLabel(subscription.provider, t('usage.unknown_provider'))} · ${subscription.name}`
        : t('usage.removed_credential');
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

  // ---------- Subscriptions ----------
  const summaries = useMemo(
    () =>
      subscriptions
        .filter((subscription) =>
          picked
            ? subscription.provider === windowSubscription?.provider
            : providerFilter === null || subscription.provider === providerFilter
        )
        .map((subscription) => summarizeSubscription(subscription, buckets, labels, now, selection))
        .sort(
          (a, b) =>
            Number(Boolean(b.window)) - Number(Boolean(a.window)) ||
            a.subscription.provider.localeCompare(b.subscription.provider) ||
            b.costUsd - a.costUsd
        ),
    [buckets, labels, now, picked, providerFilter, selection, subscriptions, windowSubscription]
  );
  const unattributedUsd = useMemo(
    () => (picked ? 0 : sumCost(selected.filter((bucket) => !bucket.authId))),
    [picked, selected]
  );

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
  const spanText = `${formatDay(selection.startMs)} – ${formatDay(selection.endMs - 1)}`;
  const inProgress = selection.endMs > now;

  const change = previousCost > 0 ? ((rollup.costUsd - previousCost) / previousCost) * 100 : null;
  const topUser = rollup.users.find((user) => user.user) ?? rollup.users[0];

  const selectWindow = (id: string) => {
    if (windowPick?.id === id) {
      setWindowPick(null);
      return;
    }
    const subscription = subscriptionById.get(id);
    if (subscription) setProvider(subscription.provider);
    setWindowPick({ id, stepsBack: 0 });
  };
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

  return (
    <div className={styles.page} ref={revealRef}>
      <header className={styles.header}>
        <div className={styles.copy}>
          <h1 className={styles.title} data-reveal>
            {t('usage.title')}
          </h1>
          <p className={styles.meta} data-reveal>
            <span className={styles.metaStrong}>
              {windowSubscription
                ? `${windowProvider} · ${windowSubscription.name}`
                : t(`usage.range_long_${range}`)}
            </span>
            <span className={styles.metaDot} aria-hidden="true">
              ·
            </span>
            <span>{spanText}</span>
            {picked && (
              <>
                <span className={styles.metaDot} aria-hidden="true">
                  ·
                </span>
                <span>
                  {inProgress
                    ? t('usage.window_resets', {
                        relative: formatRelativeInstant(selection.endMs, now, locale),
                      })
                    : t('usage.window_past')}
                </span>
              </>
            )}
          </p>
        </div>

        <div className={styles.controls} data-reveal>
          {windowSubscription && (
            <div className={styles.windowChip} role="group" aria-label={t('usage.window_label')}>
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
                <span className={styles.chipSpan}>{spanText}</span>
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
              <button
                type="button"
                className={`${styles.chipButton} ${styles.chipClose}`}
                aria-label={t('usage.window_clear')}
                onClick={() => setWindowPick(null)}
              >
                <IconX size={13} />
              </button>
            </div>
          )}
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
        </div>
      </header>

      <ProviderTabs
        types={providerTabs.types}
        counts={providerTabs.counts}
        active={windowSubscription ? windowSubscription.provider : provider}
        resolvedTheme={resolvedTheme}
        onChange={(type) => {
          setProvider(type);
          setWindowPick(null);
        }}
      />

      {ledgerState.error ? (
        <EmptyState
          title={t(ledgerState.disabled ? 'usage.disabled_title' : 'usage.load_failed_title')}
          description={t(ledgerState.disabled ? 'usage.disabled_desc' : 'usage.load_failed_desc', {
            error: ledgerState.error,
          })}
        />
      ) : showSkeleton ? (
        <div className={styles.skeletons} aria-hidden="true">
          <Skeleton height={92} rounded={14} />
          <Skeleton height={220} rounded={16} />
          <Skeleton height={320} rounded={16} />
        </div>
      ) : (
        <div
          className={`${styles.content} ${ledgerState.covered ? '' : styles.contentStale}`}
          aria-busy={!ledgerState.covered}
        >
          <section className={styles.stats} aria-label={spanText}>
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
          </section>

          <section className={styles.panel}>
            <header className={styles.panelHead}>
              <div>
                <h2 className={styles.panelTitle}>{t('usage.subs_title')}</h2>
                <p className={styles.panelHint}>{t('usage.subs_hint')}</p>
              </div>
            </header>
            <UsageSubscriptions
              summaries={summaries}
              userSlots={userColors}
              activeId={picked ? selection.authId : null}
              nowMs={now}
              resolvedTheme={resolvedTheme}
              userLabel={userLabel}
              unattributedUsd={unattributedUsd}
              onSelect={selectWindow}
            />
          </section>

          <section className={styles.panel}>
            <header className={styles.panelHead}>
              <div>
                <h2 className={styles.panelTitle}>{t('usage.chart_title')}</h2>
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
          </section>

          <section className={styles.panel}>
            <header className={styles.panelHead}>
              <div>
                <h2 className={styles.panelTitle}>{t('usage.users_title')}</h2>
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
        </div>
      )}
    </div>
  );
}
