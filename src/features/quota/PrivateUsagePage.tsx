/**
 * Private usage: the private credentials' quota windows over time. Reached only
 * by typing `#/private-usage`; nothing links here and the nav does not list it.
 * Usage & quota leaves private credentials out entirely, so this page reads their
 * history from the gateway's separate private endpoint and draws each account's
 * 5-hour session and weekly window with the forecast's remaining-quota chart.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import { useNow } from '@/hooks/useNow';
import { useThemeStore } from '@/stores';
import { quotaHistoryApi, type PrivateQuotaHistoryResult } from '@/services/api/quotaHistory';
import { getAuthFileIcon, getTypeLabel } from '@/features/authFiles/constants';
import {
  DAY_MS,
  FORECAST_HORIZON_DAYS,
  FORECAST_PAST_DAYS,
  historyLookbackDays,
  historyStartMs,
  type ForecastHorizonDays,
  type ForecastPastDays,
  type ResetAccount,
} from './quotaForecastModel';
import { privateAccountViews, type PrivateWindowView } from './privateUsageModel';
import { RemainingChart, type ForecastRow } from './components/QuotaForecastChart';
import pageStyles from './UsageQuotaPage.module.scss';
import headerStyles from './components/QuotaHeader.module.scss';
import styles from './components/QuotaForecast.module.scss';

type HistoryState = PrivateQuotaHistoryResult | { status: 'loading' } | { status: 'error' };

const NO_NIGHT: boolean[] = Array.from({ length: 24 }, () => false);

/** Loads the private history over `lookbackDays`; an older response never overwrites a newer one. */
function usePrivateQuotaHistory(lookbackDays: number, reloadKey: number): HistoryState {
  const [state, setState] = useState<HistoryState>({ status: 'loading' });
  useEffect(() => {
    let current = true;
    const nowMs = Date.now();
    quotaHistoryApi.listPrivate(nowMs - lookbackDays * DAY_MS, nowMs).then(
      (result) => {
        if (current) setState(result);
      },
      () => {
        if (current) setState({ status: 'error' });
      }
    );
    return () => {
      current = false;
    };
  }, [lookbackDays, reloadKey]);
  return state;
}

export function PrivateUsagePage({ now: nowProp }: { now?: number } = {}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage || i18n.language;
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const tick = useNow(nowProp === undefined);
  const nowMs = nowProp ?? tick;

  const [past, setPast] = useState<ForecastPastDays>(7);
  const [horizon, setHorizon] = useState<ForecastHorizonDays>(1);
  const [reloadKey, setReloadKey] = useState(0);
  const history = usePrivateQuotaHistory(historyLookbackDays(past), reloadKey);

  const samples = history.status === 'ok' ? history.samples : null;
  const fromMs = historyStartMs(past, nowMs, samples ?? [], null);
  const toMs = nowMs + horizon * DAY_MS;
  const accounts = useMemo(
    () =>
      history.status === 'ok'
        ? privateAccountViews(history.credentials, history.samples, fromMs, nowMs, toMs)
        : [],
    [history, fromMs, nowMs, toMs]
  );

  const when = useMemo(() => {
    const soon = new Intl.DateTimeFormat(language, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
    const dated = new Intl.DateTimeFormat(language, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    return (ms: number) => (Math.abs(ms - nowMs) < 6 * DAY_MS ? soon : dated).format(ms);
  }, [language, nowMs]);
  const percent = (value: number) => `${Math.round(value)}%`;
  const formatPoint = useCallback(
    (value: number) =>
      `${t('quota_management.percent_left', { percent: Math.round(value) })} · ${t(
        'quota_forecast.reset_used',
        { percent: Math.round(100 - value) }
      )}`,
    [t]
  );
  const formatJump = useCallback(
    (delta: number) => t('quota_forecast.jump', { amount: `${Math.round(delta)}%` }),
    [t]
  );
  const formatResetAccount = (account: ResetAccount, projected: boolean) => ({
    value: t(projected ? 'quota_forecast.reset_used_projected' : 'quota_forecast.reset_used', {
      percent: Math.round(account.usedPercent),
    }),
    label: t('quota_forecast.reset_row'),
  });
  const daysShort = (count: number) => t('quota_management.forecast_days_short', { count });

  const segmentGroup = <T extends number>(
    options: readonly T[],
    value: T,
    onChange: (next: T) => void,
    label: string,
    prefix: string,
    format: (option: T) => string
  ) => (
    <>
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
    </>
  );

  const windowSection = (authId: string, color: string, view: PrivateWindowView) => {
    const name = t(`private_usage.window_${view.window}`);
    const row: ForecastRow = {
      key: `${authId}:${view.window}`,
      label: name,
      color,
      capacity: 100,
      history: view.history,
      projection: view.projection,
      range: null,
      credits: [],
      resets: view.resets,
      capacityHistory: null,
      capacityMarks: [],
    };
    return (
      <section key={view.window} aria-label={name}>
        <div className={styles.cardSummary}>
          <div className={styles.hero}>
            <strong className={styles.heroValue}>
              {view.remaining === null ? '–' : percent(view.remaining)}
            </strong>
            <span className={styles.of}>{t('private_usage.left_in', { window: name })}</span>
          </div>
          <dl className={styles.stats}>
            <div className={styles.stat}>
              <dt>
                <span className={styles.statLabel}>{t('private_usage.stat_used')}</span>
              </dt>
              <dd>{view.remaining === null ? '–' : percent(100 - view.remaining)}</dd>
            </div>
            <div className={styles.stat}>
              <dt>
                <span className={styles.statLabel}>{t('quota_forecast.stat_next_reset')}</span>
              </dt>
              <dd>{view.nextResetMs === null ? '–' : when(view.nextResetMs)}</dd>
            </div>
            <div className={styles.stat}>
              <dt>
                <span className={styles.statLabel}>{t('private_usage.stat_last_sample')}</span>
              </dt>
              <dd>{view.lastSampleMs === null ? '–' : when(view.lastSampleMs)}</dd>
            </div>
          </dl>
        </div>
        {view.lastSampleMs === null ? (
          <div className={styles.unavailable} role="status">
            {t('private_usage.no_samples')}
          </div>
        ) : (
          <RemainingChart
            row={row}
            night={NO_NIGHT}
            fromMs={fromMs}
            toMs={toMs}
            nowMs={nowMs}
            formatValue={percent}
            formatPoint={formatPoint}
            formatJump={formatJump}
            ariaLabel={name}
            remainingLabel={t('quota_forecast.legend_recorded')}
            projectedLabel={t('private_usage.until_reset')}
            nowLabel={t('quota_management.forecast_now')}
            creditLabel=""
            resetLabel={t('quota_forecast.reset_row')}
            formatResetAccount={formatResetAccount}
            formatChangeCount={(count) => t('quota_forecast.capacity_changes', { count })}
          />
        )}
      </section>
    );
  };

  return (
    <div className={pageStyles.page}>
      <header className={headerStyles.header}>
        <div className={headerStyles.copy}>
          <h1 className={headerStyles.title}>{t('private_usage.title')}</h1>
          <p className={headerStyles.meta}>
            <span className={headerStyles.metaTotal}>
              {t('quota_management.meta_credentials', { count: accounts.length })}
            </span>
          </p>
        </div>
        <div className={headerStyles.actions}>
          <button
            type="button"
            className={headerStyles.primaryAction}
            onClick={() => setReloadKey((key) => key + 1)}
            disabled={history.status === 'loading'}
          >
            <IconRefreshCw size={14} aria-hidden="true" />
            {t('private_usage.refresh')}
          </button>
        </div>
      </header>

      <section className={styles.forecast} aria-label={t('private_usage.title')}>
        <div className={styles.controls}>
          <div className={styles.control}>
            {segmentGroup(
              FORECAST_PAST_DAYS,
              past,
              setPast,
              t('quota_forecast.past_label'),
              t('quota_forecast.past'),
              (days) => (days === 0 ? t('quota_forecast.past_all') : daysShort(days))
            )}
            {segmentGroup(
              FORECAST_HORIZON_DAYS,
              horizon,
              setHorizon,
              t('quota_management.forecast_horizon_label'),
              t('quota_management.forecast_next'),
              daysShort
            )}
          </div>
        </div>

        {history.status === 'disabled' && (
          <p className={styles.note}>{t('private_usage.history_off')}</p>
        )}
        {history.status === 'error' && (
          <p className={styles.note} role="alert">
            {t('private_usage.load_failed')}
          </p>
        )}
        {history.status === 'ok' && accounts.length === 0 && (
          <p className={styles.note}>{t('private_usage.no_accounts')}</p>
        )}

        {accounts.map(({ credential, windows }) => {
          const icon = getAuthFileIcon(credential.provider, resolvedTheme);
          const color = `var(--fc-${credential.provider}, var(--fc-claude))`;
          return (
            <article
              key={credential.authId}
              className={styles.card}
              style={{ '--series': color } as CSSProperties}
            >
              <header className={styles.cardHead}>
                <span className={styles.identity}>
                  {icon ? (
                    <img src={icon} alt="" className={styles.providerIcon} />
                  ) : (
                    <span className={styles.providerDot} aria-hidden="true" />
                  )}
                  <span className={styles.providerName} title={credential.authId}>
                    {credential.label}
                  </span>
                  <span className={styles.accounts}>
                    {[
                      getTypeLabel(t, credential.provider),
                      credential.privateUser &&
                        t('private_usage.private_for', { user: credential.privateUser }),
                      credential.disabled && t('private_usage.disabled'),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </header>
              {windows.some((view) => view.lastSampleMs !== null) ? (
                windows.map((view) => windowSection(credential.authId, color, view))
              ) : (
                <p className={styles.note}>{t('private_usage.no_samples')}</p>
              )}
            </article>
          );
        })}
      </section>
    </div>
  );
}
