/**
 * Pool cards: one card per forecast provider with how much of its weekly quota is
 * left across every credential, when it (or its first account) runs dry, the next
 * reset and the recent burn, over a chart of where it is heading. One control bar
 * above the cards drives them all.
 *
 * QuotaTimeline answers "when does each credential come back"; this answers "how
 * much do I have, in total, over the next days". Pools read in plan multipliers.
 */

import { useCallback, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronDown } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { useNow } from '@/hooks/useNow';
import { useThemeStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { getAuthFileIcon, getTypeLabel } from '@/features/authFiles/constants';
import {
  BURN_WINDOW_HOURS,
  DAY_MS,
  DEFAULT_SLEEP_HOURS,
  DRAIN_SPAN_DAYS,
  FORECAST_HORIZON_DAYS,
  FUTURE_USAGE,
  buildPools,
  drainBuckets,
  drainEdges,
  firstCredentialEmpty,
  futureScenario,
  learnActivity,
  nightHours,
  poolEmpty,
  poolHistory,
  poolResetCredits,
  projectPool,
  recentBurn,
  steadyActivity,
  summarizePool,
  type CardReading,
  type DrainSpanDays,
  type ForecastHorizonDays,
  type ForecastProvider,
  type PoolEmpty,
  type ResetCreditLike,
  type SleepHours,
} from '../quotaForecastModel';
import { readForecastPrefs, writeForecastPrefs, type ForecastPrefs } from '../quotaForecastPrefs';
import { formatMultiplier, shareLeft } from '../planMultipliers';
import type { QuotaHistoryState } from '../hooks/useQuotaHistory';
import { readQuotaUiState, writeQuotaUiState } from '../uiState';
import { DrainChart, RemainingChart, type ForecastRow } from './QuotaForecastChart';
import styles from './QuotaForecast.module.scss';

const SERIES_COLOR: Record<ForecastProvider, string> = {
  claude: 'var(--fc-claude)',
  codex: 'var(--fc-codex)',
  meta: 'var(--fc-meta)',
};

/** History drawn left of "now"; longer horizons keep a week so the chart stays readable. */
const MAX_HISTORY_DAYS = 7;

type ForecastView = 'remaining' | 'drain';

const LEGEND_KEY = {
  area: styles.keyArea,
  dashed: styles.keyDashed,
  range: styles.keyRange,
  bar: styles.keyBar,
  band: styles.keyBand,
  tick: styles.keyTick,
};

export interface QuotaForecastProps {
  files: AuthFileItem[];
  /** Quota history (and ledger) loaded by the page, shared with the subscription cards. */
  history: QuotaHistoryState;
  /** The page's provider filter; 'all', or a provider id. */
  tab: string;
  /** Injectable for tests/screenshots; defaults to the real clock. */
  now?: number;
  /** Readings of loaded quota cards by auth id, for credentials without live signals. */
  cardReadings?: ReadonlyMap<string, CardReading>;
  /** Manual resets loaded for a credential's quota card, if any. */
  resetCreditsFor?: (file: AuthFileItem) => readonly ResetCreditLike[] | undefined;
}

export function QuotaForecast({
  files,
  history,
  tab,
  now: nowProp,
  cardReadings,
  resetCreditsFor,
}: QuotaForecastProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage || i18n.language;
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const tick = useNow(nowProp === undefined);
  const nowMs = nowProp ?? tick;

  const samples = history.status === 'ok' ? history.samples : null;
  const ledger = history.status === 'ok' ? history.ledger : null;
  // Credentials without live signals join from their latest history reading, else their loaded card.
  const pools = useMemo(
    () => buildPools(files, samples ?? [], cardReadings),
    [files, samples, cardReadings]
  );

  const [prefs, setPrefs] = useState<ForecastPrefs>(readForecastPrefs);
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

  const numbers = useMemo(() => {
    const whole = new Intl.NumberFormat(language, { maximumFractionDigits: 0 });
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
    const date = new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric' });
    const clockHour = new Intl.DateTimeFormat(language, { hour: 'numeric', minute: '2-digit' });
    return {
      multiplier: (value: number) => formatMultiplier(value, language),
      /** Remaining as a whole percent of `of`. */
      share: (remaining: number, of: number) => whole.format((shareLeft(remaining, of) ?? 0) * 100),
      when: (ms: number) => (ms - nowMs < 6 * DAY_MS ? when : whenWithDate).format(ms),
      date: (ms: number) => date.format(ms),
      hour: (hour: number) => clockHour.format(new Date(2000, 0, 1, hour)),
    };
  }, [language, nowMs]);
  const formatPoint = useCallback(
    (value: number, capacity: number) =>
      `${numbers.multiplier(value)} · ${numbers.share(value, capacity)}%`,
    [numbers]
  );
  const formatJump = useCallback(
    (delta: number) => t('quota_forecast.jump', { amount: numbers.multiplier(delta) }),
    [numbers, t]
  );

  // Learned from every pool, not just the visible ones: one person sleeps once.
  const activity = useMemo(
    () => learnActivity(pools, samples ?? [], nowMs, sleep, ledger ?? []),
    [pools, samples, nowMs, sleep, ledger]
  );
  // "Same as now" needs history to measure the burn; without it the usual pattern stands in.
  const future = prefs.future === 'same' && !samples ? 'usual' : prefs.future;
  const projected = useMemo(
    () =>
      future === 'same' && samples
        ? steadyActivity(pools, samples, nowMs, prefs.burnHours, activity)
        : activity,
    [future, samples, pools, nowMs, prefs.burnHours, activity]
  );
  const scenario = futureScenario(future);
  const night = useMemo(() => nightHours(activity.sleep), [activity]);

  const historyDays = Math.min(horizon, MAX_HISTORY_DAYS);
  const startMs = samples ? nowMs - historyDays * DAY_MS : nowMs;
  const endMs = nowMs + horizon * DAY_MS;
  const edges = useMemo(() => drainEdges(nowMs, drainDays), [nowMs, drainDays]);

  const accountNames = useMemo(
    () =>
      new Map(
        files.flatMap((file) =>
          typeof file.id === 'string' ? [[file.id, file.email || file.name] as const] : []
        )
      ),
    [files]
  );

  const cards = useMemo(
    () =>
      visible.map((pool) => {
        const credits = resetCreditsFor
          ? poolResetCredits(pool, files, resetCreditsFor, nowMs)
          : [];
        const row: ForecastRow = {
          key: pool.provider,
          label: getTypeLabel(t, pool.provider),
          color: SERIES_COLOR[pool.provider],
          capacity: pool.capacity,
          history: samples ? poolHistory(pool, samples, startMs, nowMs) : [],
          projection: projectPool(pool, nowMs, endMs, projected, scenario),
          // The likely range is the usual pattern's spread; the other choices are one pace each.
          range:
            future === 'usual'
              ? {
                  low: projectPool(pool, nowMs, endMs, activity, 'busy'),
                  high: projectPool(pool, nowMs, endMs, activity, 'quiet'),
                }
              : null,
          credits,
        };
        const first = firstCredentialEmpty(pool, nowMs, projected, scenario);
        return {
          pool,
          row,
          summary: summarizePool(pool, nowMs, projected, scenario),
          empty: poolEmpty(pool, nowMs, endMs, projected, scenario),
          first: first && {
            name: accountNames.get(first.authId) ?? first.authId,
            atMs: first.atMs,
          },
          burn: samples ? recentBurn(pool, samples, nowMs, prefs.burnHours) : null,
          drain: samples ? drainBuckets(pool, samples, edges) : null,
        };
      }),
    [
      visible,
      resetCreditsFor,
      files,
      nowMs,
      t,
      samples,
      startMs,
      endMs,
      projected,
      scenario,
      future,
      activity,
      accountNames,
      prefs.burnHours,
      edges,
    ]
  );

  if (visible.length === 0) return null;

  const updatePrefs = (patch: Partial<ForecastPrefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      writeForecastPrefs(next);
      return next;
    });
  };
  const toggleCollapsed = (provider: ForecastProvider) =>
    updatePrefs({ collapsed: { ...prefs.collapsed, [provider]: !prefs.collapsed[provider] } });
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
  // A provider tab shows its one card open; the All tab remembers each card's state.
  const collapsible = tab === 'all';
  const drainHourly = drainDays <= 3;
  const hasNight = night.some(Boolean);
  const historyNote =
    history.status === 'disabled'
      ? t('quota_management.forecast_history_off')
      : history.status === 'error'
        ? t('quota_management.forecast_history_error')
        : null;

  const segmented = <T extends number>(
    options: readonly T[],
    value: T,
    onChange: (next: T) => void,
    label: string,
    prefix: string,
    format: (option: T) => string
  ) => (
    <div className={styles.control}>
      <span className={styles.controlLabel} aria-hidden="true">
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
            {format(option)}
          </button>
        ))}
      </div>
    </div>
  );
  const daysShort = (count: number) => t('quota_management.forecast_days_short', { count });

  const emptyText = (empty: PoolEmpty) =>
    empty.kind === 'now'
      ? t('quota_forecast.pool_empty_now')
      : empty.kind === 'at'
        ? numbers.when(empty.atMs)
        : empty.kind === 'not-before-reset'
          ? t('quota_forecast.pool_not_before_reset')
          : t('quota_forecast.pool_not_by', { date: numbers.date(empty.atMs) });

  const legendKey = (variant: keyof typeof LEGEND_KEY, color: string) => (
    <span
      className={LEGEND_KEY[variant]}
      style={{ '--series': color } as CSSProperties}
      aria-hidden="true"
    />
  );
  const legendItem = (key: ReactNode, label: string) => (
    <span key={label} className={styles.legendItem}>
      {key}
      {label}
    </span>
  );

  return (
    <section className={styles.forecast} aria-label={t('quota_management.forecast_title')}>
      <div className={styles.controls}>
        <div
          className={styles.segmented}
          role="tablist"
          aria-label={t('quota_forecast.view_label')}
        >
          {(['remaining', 'drain'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={view === value}
              onClick={() => setView(value)}
            >
              {value === 'remaining'
                ? t('quota_management.forecast_legend_remaining')
                : t('quota_management.forecast_tab_drain')}
            </button>
          ))}
        </div>
        {segmented(
          BURN_WINDOW_HOURS,
          prefs.burnHours,
          (burnHours) => updatePrefs({ burnHours }),
          t('quota_forecast.burn_window_label'),
          t('quota_forecast.burn_label'),
          (count) => t('quota_forecast.hours_short', { count })
        )}
        {view === 'remaining' && (
          <div className={styles.control}>
            <span className={styles.controlLabel} aria-hidden="true">
              {t('quota_forecast.future_label')}
            </span>
            <Select
              size="sm"
              className={styles.futureSelect}
              value={future}
              options={FUTURE_USAGE.map((value) => ({
                value,
                label: t(`quota_forecast.future_${value}`),
              }))}
              ariaLabel={t('quota_forecast.future_label')}
              onChange={(value) => {
                const next = FUTURE_USAGE.find((option) => option === value);
                if (next) updatePrefs({ future: next });
              }}
            />
          </div>
        )}
        {view === 'remaining'
          ? segmented(
              FORECAST_HORIZON_DAYS,
              horizon,
              chooseHorizon,
              t('quota_management.forecast_horizon_label'),
              t('quota_management.forecast_next'),
              daysShort
            )
          : segmented(
              DRAIN_SPAN_DAYS,
              drainDays,
              setDrainDays,
              t('quota_management.forecast_drain_span_label'),
              t('quota_management.forecast_last'),
              daysShort
            )}
      </div>
      {historyNote && view === 'remaining' && <p className={styles.note}>{historyNote}</p>}

      {cards.map(({ pool, row, summary, empty, first, burn, drain }) => {
        const provider = pool.provider;
        const name = getTypeLabel(t, provider);
        const icon = getAuthFileIcon(provider, resolvedTheme);
        const collapsed = collapsible && prefs.collapsed[provider];
        const accounts = t('quota_forecast.accounts', { count: pool.credentials.length });
        const identity = (
          <span className={styles.identity}>
            {icon ? (
              <img src={icon} alt="" className={styles.providerIcon} />
            ) : (
              <span className={styles.providerDot} aria-hidden="true" />
            )}
            <span className={styles.providerName}>{name}</span>
            <span className={styles.accounts}>{accounts}</span>
          </span>
        );
        const remaining = numbers.multiplier(summary.remaining);
        const of = t('quota_forecast.of', { capacity: numbers.multiplier(summary.capacity) });
        const nextReset = summary.nextReset && (
          <>
            <span className={styles.gain}>{formatJump(summary.nextReset.restore)}</span>{' '}
            {numbers.when(summary.nextReset.atMs)}
          </>
        );
        const style = { '--series': row.color } as CSSProperties;

        if (collapsed) {
          return (
            <article key={provider} className={styles.card} style={style}>
              <button
                type="button"
                className={styles.collapsedRow}
                aria-expanded={false}
                aria-label={t('quota_forecast.expand', { provider: name })}
                onClick={() => toggleCollapsed(provider)}
              >
                {identity}
                <span className={styles.collapsedValue}>
                  <strong>{remaining}</strong> <span className={styles.of}>{of}</span>
                </span>
                {nextReset && (
                  <span className={styles.collapsedFact}>
                    <span className={styles.collapsedFactLabel}>
                      {t('quota_forecast.stat_next_reset')}
                    </span>{' '}
                    {nextReset}
                  </span>
                )}
                <IconChevronDown size={16} className={styles.chevron} aria-hidden="true" />
              </button>
            </article>
          );
        }

        const drainPace = summary.pacePerHour * (drainHourly ? 1 : 24);
        const hasCreditMarker = row.credits.some(
          (expiresAtMs) => expiresAtMs >= startMs && expiresAtMs <= endMs
        );
        return (
          <article key={provider} className={styles.card} style={style}>
            <header className={styles.cardHead}>
              {identity}
              {collapsible && (
                <button
                  type="button"
                  className={styles.collapse}
                  aria-expanded
                  aria-label={t('quota_forecast.collapse', { provider: name })}
                  title={t('quota_forecast.collapse', { provider: name })}
                  onClick={() => toggleCollapsed(provider)}
                >
                  <IconChevronDown size={16} aria-hidden="true" />
                </button>
              )}
            </header>

            <div className={styles.cardSummary}>
              <div className={styles.hero}>
                <strong className={styles.heroValue}>{remaining}</strong>
                <span className={styles.of}>{of}</span>
              </div>
              <dl className={styles.stats}>
                <Stat label={t('quota_forecast.stat_pool_empty')}>{emptyText(empty)}</Stat>
                <Stat label={t('quota_forecast.stat_first_empty')}>
                  {first ? (
                    <>
                      <span className={styles.account} title={first.name}>
                        {first.name}
                      </span>{' '}
                      {first.atMs <= nowMs
                        ? t('quota_forecast.pool_empty_now')
                        : numbers.when(first.atMs)}
                    </>
                  ) : (
                    t('quota_forecast.first_empty_none')
                  )}
                </Stat>
                {nextReset && <Stat label={t('quota_forecast.stat_next_reset')}>{nextReset}</Stat>}
                <Stat label={t('quota_forecast.stat_burn', { count: prefs.burnHours })}>
                  {burn === null
                    ? '–'
                    : t('quota_forecast.per_hour', { rate: numbers.multiplier(burn) })}
                </Stat>
              </dl>
            </div>

            {view === 'remaining' ? (
              <RemainingChart
                row={row}
                night={night}
                fromMs={startMs}
                toMs={endMs}
                nowMs={nowMs}
                formatValue={numbers.multiplier}
                formatPoint={formatPoint}
                formatJump={formatJump}
                ariaLabel={t('quota_forecast.aria_remaining', { provider: name, count: horizon })}
                remainingLabel={t('quota_forecast.legend_recorded')}
                projectedLabel={t('quota_management.forecast_legend_projected')}
                nowLabel={t('quota_management.forecast_now')}
                creditLabel={t('quota_management.forecast_legend_reset_credit')}
              />
            ) : drain ? (
              <DrainChart
                series={[{ key: provider, label: name, color: row.color, values: drain }]}
                edges={edges}
                partialIndex={edges.length - 2}
                pace={drainPace}
                formatValue={numbers.multiplier}
                ariaLabel={
                  drainHourly
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

            <div className={styles.legend}>
              {view === 'remaining'
                ? [
                    row.history.length > 1 &&
                      legendItem(legendKey('area', row.color), t('quota_forecast.legend_recorded')),
                    legendItem(
                      legendKey('dashed', row.color),
                      t('quota_management.forecast_legend_projected')
                    ),
                    row.range &&
                      legendItem(
                        legendKey('range', row.color),
                        t('quota_management.forecast_legend_range')
                      ),
                    hasNight &&
                      legendItem(
                        legendKey('band', 'var(--text-tertiary)'),
                        t('quota_management.forecast_legend_night')
                      ),
                    hasCreditMarker &&
                      legendItem(
                        legendKey('tick', 'var(--amber-color)'),
                        t('quota_management.forecast_legend_reset_credit')
                      ),
                  ]
                : drain && [
                    legendItem(
                      legendKey('bar', row.color),
                      drainHourly
                        ? t('quota_management.forecast_used_per_hour')
                        : t('quota_management.forecast_used_per_day')
                    ),
                    legendItem(
                      legendKey('dashed', 'var(--text-secondary)'),
                      t('quota_management.forecast_pace_line', {
                        pace: numbers.multiplier(drainPace),
                      })
                    ),
                    drain.every((value) => value === 0) && (
                      <span key="empty" className={styles.legendNote}>
                        {t('quota_management.forecast_drain_empty')}
                      </span>
                    ),
                  ]}
            </div>
          </article>
        );
      })}

      <details className={styles.settings}>
        <summary>{t('quota_management.forecast_settings')}</summary>
        <div className={styles.settingsBody}>
          <span>{t('quota_management.forecast_sleep_label')}</span>
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
          <p className={styles.settingsHint}>{t('quota_management.forecast_sleep_hint')}</p>
          <p className={styles.settingsHint}>{t('quota_forecast.future_hint')}</p>
          <p className={styles.settingsHint}>{t('quota_management.forecast_pace_hint')}</p>
        </div>
      </details>
    </section>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.stat}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
