/**
 * Pooled quota forecast: how much of a provider's weekly quota is left across
 * all its credentials, where it is heading, and how fast it has been draining.
 *
 * QuotaTimeline answers "when does each credential come back"; this answers
 * "how much do I have, in total, over the next days". On the All tab pools are
 * not comparable in absolute percent (seven Claude credentials vs two Codex
 * ones), so each provider is drawn as a share of its own pool on one axis.
 */

import { useCallback, useId, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronDown } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { useNow } from '@/hooks/useNow';
import type { AuthFileItem } from '@/types';
import { getTypeLabel } from '@/features/authFiles/constants';
import type { QuotaTabId } from '../constants';
import {
  DAY_MS,
  DEFAULT_SLEEP_HOURS,
  DRAIN_SPAN_DAYS,
  FORECAST_HORIZON_DAYS,
  buildPools,
  drainBuckets,
  drainEdges,
  learnPoolActivity,
  nightHours,
  poolHistory,
  projectPool,
  summarizePool,
  toPoolShare,
  type DrainSpanDays,
  type ForecastHorizonDays,
  type ForecastProvider,
  type SleepHours,
} from '../quotaForecastModel';
import { useQuotaHistory } from '../hooks/useQuotaHistory';
import { readQuotaUiState, writeQuotaUiState } from '../uiState';
import {
  DrainChart,
  RemainingChart,
  type DrainSeries,
  type ForecastLine,
} from './QuotaForecastChart';
import styles from './QuotaForecast.module.scss';

const SERIES_COLOR: Record<ForecastProvider, string> = {
  claude: 'var(--fc-claude)',
  codex: 'var(--fc-codex)',
};

/** History drawn left of "now"; longer horizons keep a week so the chart stays readable. */
const MAX_HISTORY_DAYS = 7;

type ForecastView = 'remaining' | 'drain';

export interface QuotaForecastProps {
  files: AuthFileItem[];
  tab: QuotaTabId;
  /** Injectable for tests/screenshots; defaults to the real clock. */
  now?: number;
}

export function QuotaForecast({ files, tab, now: nowProp }: QuotaForecastProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage || i18n.language;
  const tick = useNow(nowProp === undefined);
  const nowMs = nowProp ?? tick;
  const bodyId = useId();

  const pools = useMemo(() => buildPools(files), [files]);
  const history = useQuotaHistory(pools.length > 0, files);
  const samples = history.status === 'ok' ? history.samples : null;

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

  const activities = useMemo(
    () => visible.map((pool) => learnPoolActivity(pool, samples ?? [], nowMs, sleep)),
    [visible, samples, nowMs, sleep]
  );
  // On the All tab a band is night only when every visible pool is quiet then.
  const night = useMemo(
    () =>
      activities
        .map((activity) => nightHours(activity.profile))
        .reduce(
          (all, hours) => all.map((quiet, hour) => quiet && hours[hour]),
          new Array<boolean>(24).fill(true)
        ),
    [activities]
  );

  const summaries = useMemo(
    () =>
      visible.map((pool, index) => ({
        pool,
        summary: summarizePool(pool, nowMs, activities[index]),
      })),
    [visible, nowMs, activities]
  );

  const historyDays = Math.min(horizon, MAX_HISTORY_DAYS);
  const startMs = samples ? nowMs - historyDays * DAY_MS : nowMs;
  const endMs = nowMs + horizon * DAY_MS;

  const lines = useMemo<ForecastLine[]>(
    () =>
      visible.map((pool, index) => {
        const past = samples ? poolHistory(pool, samples, startMs, nowMs) : [];
        const future = projectPool(pool, nowMs, endMs, activities[index]);
        return {
          key: pool.provider,
          label: getTypeLabel(t, pool.provider),
          color: SERIES_COLOR[pool.provider],
          history: comparative ? toPoolShare(past, pool.capacity) : past,
          projection: comparative ? toPoolShare(future, pool.capacity) : future,
        };
      }),
    [visible, samples, startMs, nowMs, endMs, comparative, activities, t]
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

  const single = summaries[0];
  const drainPace =
    drain && !comparative ? single.summary.pacePerHour * (drain.hourly ? 1 : 24) : null;
  const historyNote =
    history.status === 'disabled'
      ? t('quota_management.forecast_history_off')
      : history.status === 'error'
        ? t('quota_management.forecast_history_error')
        : null;

  const legendKey = (variant: 'line' | 'dashed' | 'bar' | 'band', color: string) => (
    <span
      className={
        variant === 'band'
          ? styles.keyBand
          : variant === 'bar'
            ? styles.keyBar
            : variant === 'dashed'
              ? styles.keyDashed
              : styles.keyLine
      }
      style={{ '--series': color } as CSSProperties}
      aria-hidden="true"
    />
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
            {summaries.map(({ pool, summary }) => (
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
                <span className={styles.pace}>
                  {t('quota_management.forecast_pace_short', {
                    pace: numbers.rate(summary.pacePerHour),
                  })}
                </span>
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
            <span className={styles.pace}>
              {t('quota_management.forecast_pace', {
                pace: numbers.rate(single.summary.pacePerHour),
              })}
            </span>
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
                {view === 'remaining' && !comparative && (
                  <>
                    <span className={styles.legendItem}>
                      {legendKey('line', lines[0].color)}
                      {t('quota_management.forecast_legend_remaining')}
                    </span>
                    <span className={styles.legendItem}>
                      {legendKey('dashed', lines[0].color)}
                      {t('quota_management.forecast_legend_projected')}
                    </span>
                  </>
                )}
                {view === 'remaining' && comparative && (
                  <>
                    {lines.map((line) => (
                      <span key={line.key} className={styles.legendItem}>
                        {legendKey('line', line.color)}
                        {line.label}
                      </span>
                    ))}
                    <span className={styles.legendNote}>
                      {t('quota_management.forecast_share_note')}
                    </span>
                  </>
                )}
                {view === 'remaining' && hasNight && (
                  <span className={styles.legendItem}>
                    {legendKey('band', 'var(--text-tertiary)')}
                    {t('quota_management.forecast_legend_night')}
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
                lines={lines}
                fromMs={startMs}
                toMs={endMs}
                nowMs={nowMs}
                yMax={comparative ? 100 : single.summary.capacity}
                fillArea={!comparative}
                night={night}
                formatValue={formatPercent}
                ariaLabel={t('quota_management.forecast_aria_remaining', { count: horizon })}
                remainingLabel={t('quota_management.forecast_legend_remaining')}
                projectedLabel={t('quota_management.forecast_legend_projected')}
                nowLabel={t('quota_management.forecast_now')}
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
                {view === 'remaining' &&
                  summaries.map(({ pool, summary }) =>
                    summary.nextReset ? (
                      <span key={pool.provider}>
                        {comparative && (
                          <span className={styles.footerProvider}>
                            {getTypeLabel(t, pool.provider)}
                          </span>
                        )}
                        {t('quota_management.forecast_next_reset', {
                          percent: numbers.percent(summary.nextReset.restorePercent),
                          when: numbers.when(summary.nextReset.atMs),
                        })}
                      </span>
                    ) : null
                  )}
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
