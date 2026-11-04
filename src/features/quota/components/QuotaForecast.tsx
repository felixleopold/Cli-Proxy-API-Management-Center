/**
 * Pool cards: one card per forecast provider with how much of its weekly quota is
 * left across every credential, when it (or its first account) runs dry, the next
 * reset and the recent burn, over a chart of where it is heading. One control bar
 * above the cards drives them all.
 *
 * QuotaTimeline answers "when does each credential come back"; this answers "how
 * much do I have, in total, over the next days". Pools read in plan multipliers.
 * "For" switches the cards' numbers to what the gateway leaves one person after
 * their reserve (GET /usage/pool?user=), with that person's reserve override.
 */

import { useCallback, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronDown } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useNow } from '@/hooks/useNow';
import { useNotificationStore, useThemeStore } from '@/stores';
import type { UsagePoolReport } from '@/services/api/usagePool';
import type { AuthFileItem } from '@/types';
import { getAuthFileIcon, getTypeLabel } from '@/features/authFiles/constants';
import { useLedgerUsers } from '@/features/usage/hooks/useLedgerUsers';
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
  poolResetEvents,
  projectPool,
  recentBurn,
  steadyActivity,
  summarizePool,
  type CardReading,
  type DrainSpanDays,
  type ForecastHorizonDays,
  type ForecastProvider,
  type PoolEmpty,
  type ProviderPool,
  type ResetAccount,
  type ResetCreditLike,
  type SleepHours,
} from '../quotaForecastModel';
import { readForecastPrefs, writeForecastPrefs, type ForecastPrefs } from '../quotaForecastPrefs';
import { formatMultiplier, shareLeft } from '../planMultipliers';
import type { QuotaHistoryState } from '../hooks/useQuotaHistory';
import { useUsagePool } from '../hooks/useUsagePool';
import {
  activeOverrideUntil,
  formatPoolTime,
  overrideTarget,
  poolProviders,
} from '../usagePoolModel';
import { HoverCard, InfoHint } from './HoverCard';
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
  const users = useLedgerUsers();
  const [person, setPerson] = useState('');
  // Only a chosen person needs the gateway's pool report; everyone is the cards' own view.
  const personPools = useUsagePool(person ? poolProviders(files, tab) : [], person);
  const showNotification = useNotificationStore((store) => store.showNotification);

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
          typeof file.id === 'string'
            ? [[file.id, file.nickname || file.email || file.name] as const]
            : []
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
          resets: poolResetEvents(pool, samples ?? [], startMs, nowMs, endMs, projected, scenario),
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
    format: (option: T) => string,
    hint: string
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
      <span className={styles.controlHint}>
        <InfoHint label={prefix} text={hint} />
      </span>
    </div>
  );
  const daysShort = (count: number) => t('quota_management.forecast_days_short', { count });

  const emptyText = (empty: PoolEmpty) =>
    empty.kind === 'now'
      ? t('quota_forecast.pool_empty_now')
      : empty.kind === 'at'
        ? numbers.when(empty.atMs)
        : empty.kind === 'not-before-reset'
          ? t('quota_forecast.runs_out_after_resets')
          : t('quota_forecast.runs_out_after', { date: numbers.date(empty.atMs) });
  const formatResetAccount = (account: ResetAccount, projectedReset: boolean) => {
    const used = Math.round(account.usedPercent);
    return {
      value: t(
        projectedReset ? 'quota_forecast.reset_used_projected' : 'quota_forecast.reset_used',
        {
          percent: used,
        }
      ),
      label:
        account.capPercent < 100
          ? t('quota_forecast.reset_account_share', {
              name: accountNames.get(account.authId) ?? account.authId,
              percent: account.capPercent,
            })
          : (accountNames.get(account.authId) ?? account.authId),
    };
  };

  // The person's view of a card: what the gateway leaves them of the card's window.
  const personReport = (pool: ProviderPool): UsagePoolReport | undefined =>
    person ? personPools.reports.find((report) => report.provider === pool.provider) : undefined;
  const personWindow = (pool: ProviderPool) => {
    const kind = pool.credentials.some((credential) => credential.window === 'weekly')
      ? 'weekly'
      : 'five_hour';
    return personReport(pool)?.windows.find(
      (window) => window.kind === kind && window.capacity > 0
    );
  };
  const shownPerson = personPools.reports.find((report) => report.user)?.user ?? null;
  const overrideUntil = activeOverrideUntil(shownPerson, nowMs);
  const overrideFor = overrideTarget(personPools.reports, person);
  const toggleOverride = async (on: boolean) => {
    try {
      if (overrideFor) await personPools.setOverride(overrideFor, on);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('common.unknown_error');
      showNotification(t('usage_pool.override_failed', { message }), 'error');
    }
  };
  const personPicker = users.length > 0 && personPools.supported && (
    <div className={styles.control}>
      <span className={styles.controlLabel} aria-hidden="true">
        {t('quota_forecast.for_label')}
      </span>
      <Select
        size="sm"
        className={styles.futureSelect}
        value={person}
        options={[
          { value: '', label: t('usage_pool.person_everyone') },
          ...users.map((name) => ({ value: name, label: name })),
        ]}
        ariaLabel={t('quota_forecast.for_label')}
        onChange={setPerson}
      />
      <span className={styles.controlHint}>
        <InfoHint label={t('quota_forecast.for_label')} text={t('quota_forecast.for_hint')} />
      </span>
    </div>
  );

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
    <section
      className={styles.forecast}
      aria-label={t('quota_management.forecast_title')}
      data-shot-section="pools"
    >
      <div className={styles.controls}>
        {personPicker}
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
          <span className={styles.controlHint}>
            <InfoHint label={t('quota_forecast.view_label')} text={t('quota_forecast.view_hint')} />
          </span>
        </div>
        {segmented(
          BURN_WINDOW_HOURS,
          prefs.burnHours,
          (burnHours) => updatePrefs({ burnHours }),
          t('quota_forecast.burn_window_label'),
          t('quota_forecast.burn_label'),
          (count) => t('quota_forecast.hours_short', { count }),
          t('quota_forecast.burn_hint')
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
            <span className={styles.controlHint}>
              <InfoHint
                label={t('quota_forecast.future_label')}
                text={t('quota_forecast.future_hint')}
              />
            </span>
          </div>
        )}
        {view === 'remaining'
          ? segmented(
              FORECAST_HORIZON_DAYS,
              horizon,
              chooseHorizon,
              t('quota_management.forecast_horizon_label'),
              t('quota_management.forecast_next'),
              daysShort,
              t('quota_forecast.horizon_hint')
            )
          : segmented(
              DRAIN_SPAN_DAYS,
              drainDays,
              setDrainDays,
              t('quota_management.forecast_drain_span_label'),
              t('quota_management.forecast_last'),
              daysShort,
              t('quota_forecast.drain_span_hint')
            )}
      </div>
      {historyNote && view === 'remaining' && <p className={styles.note}>{historyNote}</p>}
      {person && personPools.error && (
        <p className={styles.note} role="alert">
          {t('usage_pool.load_failed', { message: personPools.error })}
        </p>
      )}
      {shownPerson && (
        <div className={styles.personBar}>
          <span>
            <strong>
              {shownPerson.reservePercent > 0
                ? t('usage_pool.person_reserve', {
                    name: shownPerson.name,
                    percent: shownPerson.reservePercent,
                  })
                : shownPerson.name}
            </strong>{' '}
            ·{' '}
            {overrideUntil !== null
              ? t('usage_pool.person_override_until', {
                  time: formatPoolTime(overrideUntil, nowMs, language),
                })
              : shownPerson.reservePercent <= 0
                ? t('usage_pool.person_no_reserve')
                : shownPerson.softStopped
                  ? t('quota_forecast.person_paused')
                  : t('usage_pool.person_using')}
          </span>
          {shownPerson.reservePercent > 0 && (
            <label className={styles.override}>
              <span>{t('usage_pool.override_label')}</span>
              <ToggleSwitch
                checked={overrideUntil !== null}
                onChange={(on) => void toggleOverride(on)}
                disabled={personPools.saving || overrideFor === null}
                ariaLabel={t('usage_pool.override_aria', { name: shownPerson.name })}
              />
            </label>
          )}
        </div>
      )}

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
        const forPerson = personWindow(pool);
        const remaining = numbers.multiplier(
          forPerson ? (forPerson.capacity * forPerson.leftForUserPercent) / 100 : summary.remaining
        );
        const of = forPerson
          ? t('quota_forecast.left_for', {
              name: person,
              percent: Math.round(forPerson.leftForUserPercent),
              capacity: numbers.multiplier(forPerson.capacity),
            })
          : t('quota_forecast.of', { capacity: numbers.multiplier(summary.capacity) });
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
              <HoverCard
                className={styles.hero}
                focusable
                content={
                  forPerson ? t('quota_forecast.hero_person_hint') : t('quota_forecast.hero_hint')
                }
              >
                <strong className={styles.heroValue}>{remaining}</strong>
                <span className={styles.of}>{of}</span>
              </HoverCard>
              <dl className={styles.stats}>
                <Stat
                  label={t('quota_forecast.stat_runs_out')}
                  hint={t('quota_forecast.stat_runs_out_hint', { count: horizon })}
                >
                  {emptyText(empty)}
                </Stat>
                <Stat
                  label={t('quota_forecast.stat_first_dry')}
                  hint={t('quota_forecast.stat_first_dry_hint')}
                >
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
                {nextReset && (
                  <Stat
                    label={t('quota_forecast.stat_next_reset')}
                    hint={t('quota_forecast.stat_next_reset_hint')}
                  >
                    {nextReset}
                  </Stat>
                )}
                <Stat
                  label={t('quota_forecast.stat_burn', { count: prefs.burnHours })}
                  hint={t('quota_forecast.stat_burn_hint', { count: prefs.burnHours })}
                >
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
                formatResetAccount={formatResetAccount}
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
                    row.resets.length > 0 && (
                      <HoverCard
                        key="resets"
                        className={styles.legendItem}
                        focusable
                        content={t('quota_forecast.legend_resets_hint')}
                      >
                        {t('quota_forecast.legend_resets')}
                        {(['full', 'partial', 'low'] as const).map((use) => (
                          <span key={use} className={styles.legendUse}>
                            <span className={styles.keyDot} data-use={use} aria-hidden="true" />
                            {t(`quota_forecast.legend_reset_${use}`)}
                          </span>
                        ))}
                      </HoverCard>
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

/** A labelled number; hovering or focusing the label explains it. */
function Stat({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className={styles.stat}>
      <dt>
        <HoverCard content={hint} focusable align="end">
          <span className={styles.statLabel}>{label}</span>
        </HoverCard>
      </dt>
      <dd>{children}</dd>
    </div>
  );
}
