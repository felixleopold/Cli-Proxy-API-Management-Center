/**
 * Usage: API-equivalent USD per user per weekly window, with device and model
 * drill-down and the client key → device/user labels. Logic lives in usageModel.ts.
 */

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useRevealGroup } from '@/hooks/motion';
import { useNow } from '@/hooks/useNow';
import { useNotificationStore } from '@/stores';
import type { UsageClient, UsageClientLabel } from '@/types';
import { maskApiKey, formatPercent } from '@/utils/format';
import { formatRelativeInstant } from '@/utils/quota/relativeTime';
import { UsageClientsEditor } from './components/UsageClientsEditor';
import { UsageUsersTable } from './components/UsageUsersTable';
import { UsageWeeklyChart } from './components/UsageWeeklyChart';
import { useClaudeWeekResets } from './hooks/useClaudeWeekResets';
import { useUsageData } from './hooks/useUsageData';
import {
  assignUserSlots,
  buildClientRows,
  buildWeekWindows,
  paceCost,
  formatUsd,
  resolveWeekAnchor,
  rollupWindows,
  type WeekAnchorMode,
} from './usageModel';
import styles from './UsagePage.module.scss';

const ANCHOR_MODES: WeekAnchorMode[] = ['claude', 'calendar'];

export function UsagePage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const showNotification = useNotificationStore((state) => state.showNotification);
  const revealRef = useRevealGroup<HTMLDivElement>();
  const now = useNow();

  const [mode, setMode] = useState<WeekAnchorMode>('claude');
  // Selection as "weeks back" so it survives an anchor switch.
  const [weeksBack, setWeeksBack] = useState(0);

  const { ledger, clients, apiKeys, error, disabled, loading, reload, saveClients } =
    useUsageData();
  const claude = useClaudeWeekResets(mode === 'claude');
  useHeaderRefresh(reload);

  const anchor = useMemo(
    () => resolveWeekAnchor(mode, claude.resets, now),
    [mode, claude.resets, now]
  );
  const windows = useMemo(() => buildWeekWindows(anchor, now), [anchor, now]);

  // The clients endpoint is fresher than the ledger's copy (it reflects saves).
  const labels = useMemo<UsageClient[]>(() => {
    const merged = new Map((ledger?.clients ?? []).map((client) => [client.fingerprint, client]));
    clients?.forEach((client) => merged.set(client.fingerprint, client));
    return Array.from(merged.values());
  }, [clients, ledger]);

  const rollups = useMemo(
    () => rollupWindows(ledger?.buckets ?? [], labels, windows),
    [labels, ledger, windows]
  );
  const slots = useMemo(() => assignUserSlots(rollups), [rollups]);
  const clientRows = useMemo(() => buildClientRows(labels, apiKeys), [apiKeys, labels]);
  const keyHints = useMemo(
    () =>
      new Map(
        clientRows.flatMap((row) => (row.apiKey ? [[row.fingerprint, maskApiKey(row.apiKey)]] : []))
      ),
    [clientRows]
  );

  const userLabel = useCallback((user: string) => user || t('usage.unassigned'), [t]);
  const formatDay = useCallback(
    (ms: number) => new Date(ms).toLocaleDateString(locale, { month: 'short', day: 'numeric' }),
    [locale]
  );
  const formatWindow = useCallback(
    (startMs: number, endMs: number) => `${formatDay(startMs)} – ${formatDay(endMs - 1)}`,
    [formatDay]
  );
  const formatInstant = (ms: number) =>
    new Date(ms).toLocaleString(locale, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  const selectedIndex = Math.max(0, rollups.length - 1 - weeksBack);
  const selected = rollups[selectedIndex];
  const previous = rollups[selectedIndex - 1];
  const current = rollups[rollups.length - 1];
  const before = rollups[rollups.length - 2];

  // Last window's spend by the same point in time: the fair comparison mid-window.
  const paceCostUsd =
    ledger && current && before
      ? paceCost(ledger.buckets, before.window, current.window, ledger.toMs)
      : null;
  const compareCost = selected?.window.current ? paceCostUsd : (previous?.costUsd ?? null);
  const change =
    selected && compareCost ? ((selected.costUsd - compareCost) / compareCost) * 100 : null;
  const topUser = selected?.users.find((user) => user.user) ?? selected?.users[0];

  const anchorText =
    anchor.kind === 'claude'
      ? t('usage.anchor_claude', { time: formatInstant(anchor.resetMs) })
      : mode === 'calendar'
        ? t('usage.anchor_calendar')
        : claude.loading
          ? t('usage.anchor_claude_loading')
          : t('usage.anchor_claude_missing');

  const handleSave = async (next: UsageClientLabel[]) => {
    try {
      await saveClients(next);
      showNotification(t('usage.clients_saved'), 'success');
    } catch (err: unknown) {
      showNotification(
        `${t('usage.clients_save_failed')}: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      );
      throw err;
    }
  };

  const showSkeleton = loading && !ledger;

  return (
    <div className={styles.page} ref={revealRef}>
      <header className={styles.header}>
        <div className={styles.copy}>
          <h1 className={styles.title} data-reveal>
            {t('usage.title')}
          </h1>
          <p className={styles.meta} data-reveal>
            <span className={anchor.kind === 'claude' ? styles.metaLive : undefined}>
              {anchorText}
            </span>
            {current && (
              <>
                <span className={styles.metaDot} aria-hidden="true">
                  ·
                </span>
                <span>
                  {t('usage.window_ends', {
                    relative: formatRelativeInstant(current.window.endMs, now, locale),
                  })}
                </span>
              </>
            )}
          </p>
        </div>
        <div className={styles.modes} role="group" aria-label={t('usage.anchor_label')} data-reveal>
          {ANCHOR_MODES.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {t(`usage.mode_${value}`)}
            </button>
          ))}
        </div>
      </header>

      {error ? (
        <EmptyState
          title={t(disabled ? 'usage.disabled_title' : 'usage.load_failed_title')}
          description={t(disabled ? 'usage.disabled_desc' : 'usage.load_failed_desc', { error })}
        />
      ) : showSkeleton || !selected ? (
        <div className={styles.skeletons} aria-hidden="true">
          <Skeleton height={112} rounded={14} />
          <Skeleton height={300} rounded={16} />
          <Skeleton height={220} rounded={16} />
        </div>
      ) : (
        <>
          <section
            className={styles.statsRow}
            aria-label={formatWindow(selected.window.startMs, selected.window.endMs)}
          >
            <article className={`${styles.statTile} ${styles.tileHero}`}>
              <span className={styles.statLabel}>
                {selected.window.current
                  ? t('usage.stat_spend_current')
                  : t('usage.stat_spend', {
                      window: formatWindow(selected.window.startMs, selected.window.endMs),
                    })}
              </span>
              <span className={styles.statValue}>{formatUsd(selected.costUsd, locale)}</span>
              <span className={styles.statHint}>
                {t('usage.stat_spend_hint', {
                  requests: selected.requests.toLocaleString(locale),
                })}
              </span>
            </article>
            <article className={styles.statTile}>
              <span className={styles.statLabel}>
                {selected.window.current ? t('usage.stat_change_pace') : t('usage.stat_change')}
              </span>
              <span className={styles.statValue}>
                {change === null ? '—' : `${change > 0 ? '+' : ''}${formatPercent(change, 0)}`}
              </span>
              <span className={styles.statHint}>
                {compareCost === null
                  ? t('usage.stat_change_none')
                  : t(
                      selected.window.current
                        ? 'usage.stat_change_pace_hint'
                        : 'usage.stat_change_hint',
                      { amount: formatUsd(compareCost, locale) }
                    )}
              </span>
            </article>
            <article className={styles.statTile}>
              <span className={styles.statLabel}>
                {selected.window.current ? t('usage.stat_ends') : t('usage.stat_ended')}
              </span>
              <span className={styles.statValue}>
                {selected.window.current
                  ? formatRelativeInstant(selected.window.endMs, now, locale)
                  : formatDay(selected.window.endMs - 1)}
              </span>
              <span className={styles.statHint}>{formatInstant(selected.window.endMs)}</span>
            </article>
            <article className={styles.statTile}>
              <span className={styles.statLabel}>{t('usage.stat_top_user')}</span>
              <span className={`${styles.statValue} ${styles.statName}`}>
                {topUser ? userLabel(topUser.user) : '—'}
              </span>
              <span className={styles.statHint}>
                {topUser && selected.costUsd > 0
                  ? t('usage.stat_top_user_hint', {
                      share: formatPercent((topUser.costUsd / selected.costUsd) * 100, 0),
                      count: selected.users.filter((user) => user.user).length,
                    })
                  : t('usage.window_empty')}
              </span>
            </article>
          </section>

          <section className={styles.panel}>
            <header className={styles.panelHead}>
              <h2 className={styles.panelTitle}>{t('usage.chart_title')}</h2>
              <p className={styles.panelHint}>{t('usage.chart_hint')}</p>
            </header>
            <UsageWeeklyChart
              rollups={rollups}
              slots={slots}
              selectedIndex={selectedIndex}
              onSelect={(index) => setWeeksBack(rollups.length - 1 - index)}
              paceCostUsd={paceCostUsd}
              userLabel={userLabel}
              formatWindow={formatWindow}
              formatDay={formatDay}
            />
          </section>

          <section className={styles.panel}>
            <header className={styles.panelHead}>
              <h2 className={styles.panelTitle}>
                {t('usage.users_title', {
                  window: formatWindow(selected.window.startMs, selected.window.endMs),
                })}
              </h2>
            </header>
            <UsageUsersTable
              key={selected.window.startMs}
              rollup={selected}
              slots={slots}
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
              <h2 className={styles.panelTitle}>{t('usage.clients_title')}</h2>
              <p className={styles.panelHint}>{t('usage.clients_hint')}</p>
            </header>
            <UsageClientsEditor
              rows={clientRows}
              disabled={loading || clients === null}
              onSave={handleSave}
            />
          </section>
        </>
      )}
    </div>
  );
}
