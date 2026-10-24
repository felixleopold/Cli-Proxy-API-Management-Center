/**
 * Pooled quota forecast: how much of a provider's weekly quota is left across
 * all its credentials, where it is heading, and how fast it has been draining.
 *
 * QuotaTimeline answers "when does each credential come back"; this answers
 * "how much do I have, in total, over the next days". On the All tab each
 * provider gets its own row in absolute pool percent (seven Claude credentials
 * vs two Codex ones would not share one axis well), all on one time axis.
 */

import { useCallback, useId, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronDown } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { useNow } from '@/hooks/useNow';
import type { AuthFileItem } from '@/types';
import { getTypeLabel } from '@/features/authFiles/constants';
import {
  DAY_MS,
  DEFAULT_SLEEP_HOURS,
  DRAIN_SPAN_DAYS,
  FORECAST_HORIZON_DAYS,
  buildPools,
  drainBuckets,
  drainEdges,
  learnActivity,
  nightHours,
  poolHistory,
  poolResetCredits,
  projectPool,
  runsOutAt,
  summarizePool,
  type DrainSpanDays,
  type ForecastHorizonDays,
  type ForecastProvider,
  type ResetCreditLike,
  type SleepHours,
} from '../quotaForecastModel';
import type { QuotaHistoryState } from '../hooks/useQuotaHistory';
import { readQuotaUiState, writeQuotaUiState } from '../uiState';
import {
  DrainChart,
  RemainingChart,
  type DrainSeries,
  type ForecastRow,
} from './QuotaForecastChart';
import styles from './QuotaForecast.module.scss';

const SERIES_COLOR: Record<ForecastProvider, string> = {
  claude: 'var(--fc-claude)',
  codex: 'var(--fc-codex)',
  meta: 'var(--fc-meta)',
};

/** History drawn left of "now"; longer horizons keep a week so the chart stays readable. */
const MAX_HISTORY_DAYS = 7;

type ForecastView = 'remaining' | 'drain';

export interface QuotaForecastProps {
  files: AuthFileItem[];
  /** Quota history (and ledger) loaded by the page, shared with the subscription cards. */
  history: QuotaHistoryState;
  /** The page's provider filter; 'all', or a provider id. */
  tab: string;
  /** Injectable for tests/screenshots; defaults to the real clock. */
  now?: number;
  /** Manual resets loaded for a credential's quota card, if any. */
  resetCreditsFor?: (file: AuthFileItem) => readonly ResetCreditLike[] | undefined;
}

export function QuotaForecast({
  files,
  history,
  tab,
  now: nowProp,
  resetCreditsFor,
}: QuotaForecastProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage || i18n.language;
  const tick = useNow(nowProp === undefined);
  const nowMs = nowProp ?? tick;
  const bodyId = useId();

  const samples = history.status === 'ok' ? history.samples : null;
  const ledger = history.status === 'ok' ? history.ledger : null;
  // Credentials without live signals join from their latest history reading.
  const pools = useMemo(() => buildPools(files, samples ?? []), [files, samples]);

  const [collapsed, setCollapsed] = useState(() => readQuotaUiState()?.forecastCollapsed ?? false);
  const [horizon, setHorizon] = useState<ForecastHorizonDays>(
    () => readQuotaUiState()?.forecastHorizon ?? 7
  );
  const [sleep, setSleep] = useState<SleepHours>(() => {
    const stored = readQuotaUiState();
    return {
      startHour: stored?.forecastSleepStart ?? DEFAULT_SLEEP_HOURS.startHour,
      endHour: stored?.forecastSleepEnd ?? DEFAULT_SLEEP_HOURS.endHour,
    };
  });
  const [view, setView] = useState<ForecastView>('remaining');
  const [drainDays, setDrainDays] = useState<DrainSpanDays>(7);

  const visible = useMemo(
    () => (tab === 'all' ? pools : pools.filter((pool) => pool.provider === tab)),
    [pools, tab]
  );
  const comparative = visible.length > 1;

  const numbers = useMemo(() => {
    const whole = new Intl.NumberFormat(language, { maximumFractionDigits: 0 });
    const tenth = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
    const when = new Intl.DateTimeFormat(language, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
    const whenWithDate = new Intl.DateTimeFormat(language, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    const clockHour = new Intl.DateTimeFormat(language, { hour: 'numeric', minute: '2-digit' });
    return {
      percent: (value: number) => whole.format(value),
      rate: (value: number) => (value >= 10 ? whole.format(value) : tenth.format(value)),
      when: (ms: number) => (ms - nowMs < 6 * DAY_MS ? when : whenWithDate).format(ms),
      hour: (hour: number) => clockHour.format(new Date(2000, 0, 1, hour)),
    };
  }, [language, nowMs]);
  const formatPercent = useCallback((value: number) => `${numbers.percent(value)}%`, [numbers]);
  const formatRate = useCallback((value: number) => `${numbers.rate(value)}%`, [numbers]);

  // Learned from every pool, not just the visible ones: one person sleeps once.
  const activity = useMemo(
    () => learnActivity(pools, samples ?? [], nowMs, sleep, ledger ?? []),
    [pools, samples, nowMs, sleep, ledger]
  );
  const night = useMemo(() => nightHours(activity.sleep), [activity]);
  const summaries = useMemo(
    () =>
      visible.map((pool) => ({
        pool,
        summary: summarizePool(pool, nowMs, activity),
        credits: resetCreditsFor ? poolResetCredits(pool, files, resetCreditsFor, nowMs) : [],
      })),
    [visible, nowMs, activity, files, resetCreditsFor]
  );

  const historyDays = Math.min(horizon, MAX_HISTORY_DAYS);
  const startMs = samples ? nowMs - historyDays * DAY_MS : nowMs;
  const endMs = nowMs + horizon * DAY_MS;

  const rows = useMemo<ForecastRow[]>(
    () =>
      summaries.map(({ pool, summary, credits }) => {
        const range = {
          low: projectPool(pool, nowMs, endMs, activity, 'busy'),
          high: projectPool(pool, nowMs, endMs, activity, 'quiet'),
        };
        const soonest = runsOutAt(range.low);
        const latest = runsOutAt(range.high);
        const facts = [
          summary.nextReset &&
            t('quota_management.forecast_next_reset', {
              percent: numbers.percent(summary.nextReset.restorePercent),
              when: numbers.when(summary.nextReset.atMs),
            }),
          // A quiet pace may outlast the view or a reset; then only the soonest is known.
          soonest !== null &&
            (latest === null
              ? t('quota_management.forecast_runs_out_soonest', { when: numbers.when(soonest) })
              : numbers.when(soonest) === numbers.when(latest)
                ? t('quota_management.forecast_runs_out', { when: numbers.when(soonest) })
                : t('quota_management.forecast_runs_out_range', {
                    from: numbers.when(soonest),
                    to: numbers.when(latest),
                  })),
          // Manual resets are redeemed by hand, so the projection ignores them; say one could extend it.
          soonest !== null &&
            credits.length > 0 &&
            t('quota_management.forecast_runs_out_credit', {
              count: credits.length,
              when: numbers.when(credits[0]),
            }),
        ];
        return {
          key: pool.provider,
          label: getTypeLabel(t, pool.provider),
          color: SERIES_COLOR[pool.provider],
          capacity: pool.capacity,
          history: samples ? poolHistory(pool, samples, startMs, nowMs) : [],
          projection: projectPool(pool, nowMs, endMs, activity),
          range,
          credits,
          facts: facts.filter(Boolean).join(' · '),
        };
      }),
    [summaries, samples, startMs, nowMs, endMs, activity, numbers, t]
  );

  const drain = useMemo(() => {
    if (!samples) return null;
    const edges = drainEdges(nowMs, drainDays);
    const series: DrainSeries[] = visible.map((pool) => {
      const values = drainBuckets(pool, samples, edges);
      return {
        key: pool.provider,
        label: getTypeLabel(t, pool.provider),
        color: SERIES_COLOR[pool.provider],
        values: comparative ? values.map((value) => (value / pool.capacity) * 100) : values,
      };
    });
    const empty = series.every((entry) => entry.values.every((value) => value === 0));
    return { edges, hourly: drainDays <= 3, series, empty, partialIndex: edges.length - 2 };
  }, [samples, nowMs, drainDays, visible, comparative, t]);

  if (visible.length === 0) return null;

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      writeQuotaUiState({ forecastCollapsed: !value });
      return !value;
    });
  };
  const chooseHorizon = (days: ForecastHorizonDays) => {
    setHorizon(days);
    writeQuotaUiState({ forecastHorizon: days });
  };
  const chooseSleep = (next: SleepHours) => {
    setSleep(next);
    writeQuotaUiState({ forecastSleepStart: next.startHour, forecastSleepEnd: next.endHour });
  };
  const hourOptions = Array.from({ length: 24 }, (_, hour) => ({
    value: String(hour),
    label: numbers.hour(hour),
  }));
  const hasNight = night.some(Boolean);
  const hasCreditMarker = rows.some((row) =>
    row.credits.some((expiresAtMs) => expiresAtMs <= endMs)
  );
  const paceHint = t('quota_management.forecast_pace_hint');
  const keyColor = comparative ? 'var(--text-secondary)' : rows[0].color;

  const single = summaries[0];
  const drainPace =
    drain && !comparative ? single.summary.pacePerHour * (drain.hourly ? 1 : 24) : null;
  const historyNote =
    history.status === 'disabled'
      ? t('quota_management.forecast_history_off')
      : history.status === 'error'
        ? t('quota_management.forecast_history_error')
        : null;

  const legendKey = (
    variant: 'area' | 'dashed' | 'range' | 'bar' | 'band' | 'tick',
    color: string
  ) => (
    <span
      className={
        variant === 'tick'
          ? styles.keyTick
          : variant === 'band'
            ? styles.keyBand
            : variant === 'bar'
              ? styles.keyBar
              : variant === 'range'
                ? styles.keyRange
                : variant === 'dashed'
                  ? styles.keyDashed
                  : styles.keyArea
      }
      style={{ '--series': color } as CSSProperties}
      aria-hidden="true"
    />
  );

  const creditCount = (credits: number[]) =>
    credits.length > 0 && (
      <span className={styles.credits}>
        {legendKey('tick', 'var(--amber-color)')}
        {t('quota_management.forecast_reset_credits', { count: credits.length })}
      </span>
    );

  const segmented = <T extends number>(
    options: readonly T[],
    value: T,
    onChange: (next: T) => void,
    label: string,
    prefix: string
  ) => (
    <div className={styles.rangeControl}>
      <span className={styles.rangePrefix} aria-hidden="true">
        {prefix}
      </span>
      <div className={styles.segmented} role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={option === value}
            onClick={() => onChange(option)}
          >
            {t('quota_management.forecast_days_short', { count: option })}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <section className={styles.forecast} aria-label={t('quota_management.forecast_title')}>
      <header className={styles.summary}>
        {comparative ? (
          <div className={styles.pools}>
            {summaries.map(({ pool, summary, credits }) => (
              <span key={pool.provider} className={styles.poolSummary}>
                <span
                  className={styles.poolDot}
                  style={{ '--series': SERIES_COLOR[pool.provider] } as CSSProperties}
                  aria-hidden="true"
                />
                <span className={styles.poolName}>{getTypeLabel(t, pool.provider)}</span>
                <strong className={styles.poolValue}>{formatPercent(summary.remaining)}</strong>
                <span className={styles.poolOf}>
                  {t('quota_management.forecast_remaining_of', {
                    capacity: numbers.percent(summary.capacity),
                  })}
                </span>
                <span className={styles.pace} title={paceHint}>
                  {t('quota_management.forecast_pace_short', {
                    pace: numbers.rate(summary.pacePerHour * 24),
                  })}
                </span>
                {creditCount(credits)}
              </span>
            ))}
          </div>
        ) : (
          <div className={styles.hero}>
            <strong className={styles.heroValue}>{formatPercent(single.summary.remaining)}</strong>
            <span className={styles.heroOf}>
              {t('quota_management.forecast_remaining_of', {
                capacity: numbers.percent(single.summary.capacity),
              })}
            </span>
            <span className={styles.pace} title={paceHint}>
              {t('quota_management.forecast_pace', {
                pace: numbers.rate(single.summary.pacePerHour * 24),
              })}
            </span>
            {creditCount(single.credits)}
          </div>
        )}
        <button
          type="button"
          className={styles.collapse}
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          aria-label={
            collapsed
              ? t('quota_management.forecast_expand')
              : t('quota_management.forecast_collapse')
          }
          title={
            collapsed
              ? t('quota_management.forecast_expand')
              : t('quota_management.forecast_collapse')
          }
          onClick={toggleCollapsed}
        >
          <IconChevronDown size={16} aria-hidden="true" />
        </button>
      </header>

      {!collapsed && (
        <div id={bodyId} className={styles.body}>
          <div className={styles.views} role="tablist">
            {(['remaining', 'drain'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={view === value}
                onClick={() => setView(value)}
              >
                {value === 'remaining'
                  ? t('quota_management.forecast_tab_remaining')
                  : t('quota_management.forecast_tab_drain')}
              </button>
            ))}
          </div>

          <div role="tabpanel" className={styles.panel}>
            <div className={styles.legendRow}>
              <div className={styles.legend}>
                {view === 'remaining' && (
                  <>
                    <span className={styles.legendItem}>
                      {legendKey('area', keyColor)}
                      {t('quota_management.forecast_legend_remaining')}
                    </span>
                    <span className={styles.legendItem}>
                      {legendKey('dashed', keyColor)}
                      {t('quota_management.forecast_legend_projected')}
                    </span>
                    <span className={styles.legendItem}>
                      {legendKey('range', keyColor)}
                      {t('quota_management.forecast_legend_range')}
                    </span>
                  </>
                )}
                {view === 'remaining' && hasNight && (
                  <span className={styles.legendItem}>
                    {legendKey('band', 'var(--text-tertiary)')}
                    {t('quota_management.forecast_legend_night')}
                  </span>
                )}
                {view === 'remaining' && hasCreditMarker && (
                  <span className={styles.legendItem}>
                    {legendKey('tick', 'var(--amber-color)')}
                    {t('quota_management.forecast_legend_reset_credit')}
                  </span>
                )}
                {view === 'drain' &&
                  drain &&
                  (comparative ? (
                    <>
                      {drain.series.map((entry) => (
                        <span key={entry.key} className={styles.legendItem}>
                          {legendKey('bar', entry.color)}
                          {entry.label}
                        </span>
                      ))}
                      <span className={styles.legendNote}>
                        {drain.hourly
                          ? t('quota_management.forecast_share_per_hour')
                          : t('quota_management.forecast_share_per_day')}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className={styles.legendItem}>
                        {legendKey('bar', drain.series[0].color)}
                        {drain.hourly
                          ? t('quota_management.forecast_used_per_hour')
                          : t('quota_management.forecast_used_per_day')}
                      </span>
                      {drainPace !== null && (
                        <span className={styles.legendItem}>
                          {legendKey('dashed', 'var(--text-secondary)')}
                          {t('quota_management.forecast_pace_line', {
                            pace: numbers.rate(drainPace),
                          })}
                        </span>
                      )}
                    </>
                  ))}
              </div>
              {view === 'remaining'
                ? segmented(
                    FORECAST_HORIZON_DAYS,
                    horizon,
                    chooseHorizon,
                    t('quota_management.forecast_horizon_label'),
                    t('quota_management.forecast_next')
                  )
                : segmented(
                    DRAIN_SPAN_DAYS,
                    drainDays,
                    setDrainDays,
                    t('quota_management.forecast_drain_span_label'),
                    t('quota_management.forecast_last')
                  )}
            </div>

            {view === 'remaining' ? (
              <RemainingChart
                rows={rows}
                night={night}
                fromMs={startMs}
                toMs={endMs}
                nowMs={nowMs}
                formatValue={formatPercent}
                ariaLabel={t('quota_management.forecast_aria_remaining', { count: horizon })}
                remainingLabel={t('quota_management.forecast_legend_remaining')}
                projectedLabel={t('quota_management.forecast_legend_projected')}
                nowLabel={t('quota_management.forecast_now')}
                creditLabel={t('quota_management.forecast_legend_reset_credit')}
              />
            ) : drain ? (
              <DrainChart
                series={drain.series}
                edges={drain.edges}
                partialIndex={drain.partialIndex}
                pace={drainPace}
                formatValue={formatRate}
                ariaLabel={
                  drain.hourly
                    ? t('quota_management.forecast_used_per_hour')
                    : t('quota_management.forecast_used_per_day')
                }
                soFarLabel={t('quota_management.forecast_so_far')}
              />
            ) : (
              <div className={styles.unavailable} role="status">
                {history.status === 'loading'
                  ? null
                  : history.status === 'disabled'
                    ? t('quota_management.forecast_drain_unavailable')
                    : t('quota_management.forecast_history_error')}
              </div>
            )}

            <footer className={styles.footer}>
              <div className={styles.footerFacts}>
                {view === 'drain' && drain?.empty && (
                  <span>{t('quota_management.forecast_drain_empty')}</span>
                )}
              </div>
              {view === 'remaining' && historyNote && (
                <span className={styles.note}>{historyNote}</span>
              )}
              {view === 'remaining' && (
                <details className={styles.settings}>
                  <summary>{t('quota_management.forecast_settings')}</summary>
                  <div className={styles.settingsBody}>
                    <span className={styles.settingsLabel}>
                      {t('quota_management.forecast_sleep_label')}
                    </span>
                    <Select
                      size="sm"
                      className={styles.hourSelect}
                      value={String(sleep.startHour)}
                      options={hourOptions}
                      ariaLabel={t('quota_management.forecast_sleep_start')}
                      onChange={(value) => chooseSleep({ ...sleep, startHour: Number(value) })}
                    />
                    <span aria-hidden="true">–</span>
                    <Select
                      size="sm"
                      className={styles.hourSelect}
                      value={String(sleep.endHour)}
                      options={hourOptions}
                      ariaLabel={t('quota_management.forecast_sleep_end')}
                      onChange={(value) => chooseSleep({ ...sleep, endHour: Number(value) })}
                    />
                    <p className={styles.settingsHint}>
                      {t('quota_management.forecast_sleep_hint')}
                    </p>
                    <p className={styles.settingsHint}>{paceHint}</p>
                  </div>
                </details>
              )}
            </footer>
          </div>
        </div>
      )}
    </section>
  );
}
