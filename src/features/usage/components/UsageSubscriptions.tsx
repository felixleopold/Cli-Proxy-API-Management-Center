import { useTranslation } from 'react-i18next';
import { getAuthFileIcon, type ResolvedTheme } from '@/features/authFiles/constants';
import { providerLabel } from '@/features/dashboard/utils';
import { formatPercent } from '@/utils/format';
import { formatRelativeInstant } from '@/utils/quota/relativeTime';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';
import { formatUsd, type SeriesSlot, type SubscriptionSummary } from '../usageModel';
import { slotClassName } from './slotClass';
import styles from './UsageSubscriptions.module.scss';

/** Named users shown under the split bar before the rest are counted. */
const SPLIT_LEGEND_COUNT = 3;

interface UsageSubscriptionsProps {
  summaries: SubscriptionSummary[];
  userSlots: Map<string, SeriesSlot>;
  /** The subscription whose window the page shows. */
  activeId: string | null;
  nowMs: number;
  resolvedTheme: ResolvedTheme;
  userLabel: (user: string) => string;
  /** Spend in the selection that no credential is recorded for. */
  unattributedUsd: number;
  onSelect: (id: string) => void;
}

const formatPeriod = (ms: number) =>
  ms % DAY_MS === 0 ? `${ms / DAY_MS}d` : `${Math.round(ms / HOUR_MS)}h`;

export function UsageSubscriptions({
  summaries,
  userSlots,
  activeId,
  nowMs,
  resolvedTheme,
  userLabel,
  unattributedUsd,
  onSelect,
}: UsageSubscriptionsProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;

  const formatInstant = (ms: number) =>
    new Date(ms).toLocaleString(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  if (summaries.length === 0) {
    return <p className={styles.empty}>{t('usage.subs_empty')}</p>;
  }

  return (
    <>
      <ul className={styles.grid}>
        {summaries.map((summary) => {
          const { subscription, window, usedPercent, sessionUsedPercent } = summary;
          const iconSrc = getAuthFileIcon(subscription.provider, resolvedTheme);
          const provider = providerLabel(subscription.provider, t('usage.unknown_provider'));
          const named = summary.users.slice(0, SPLIT_LEGEND_COUNT);
          const rest = summary.users.length - named.length;
          const observedAtMs = subscription.observedAtMs;

          const body = (
            <>
              <span className={styles.head}>
                <span className={styles.icon} aria-hidden="true">
                  {iconSrc ? <img src={iconSrc} alt="" /> : provider.slice(0, 1)}
                </span>
                <span className={styles.identity}>
                  <span className={styles.name} title={subscription.name}>
                    {subscription.name || subscription.id}
                  </span>
                  <span className={styles.provider}>{provider}</span>
                </span>
                {window && (
                  <span className={styles.reset} title={formatInstant(window.endMs)}>
                    {t('usage.sub_resets', {
                      relative: formatRelativeInstant(window.endMs, nowMs, locale),
                    })}
                  </span>
                )}
              </span>

              {window && subscription.quota ? (
                <span className={styles.quota}>
                  <span className={styles.windowLine}>
                    {formatInstant(window.startMs)}
                    <span aria-hidden="true"> → </span>
                    <span className={styles.srOnly}> – </span>
                    {formatInstant(window.endMs)}
                  </span>
                  <span className={styles.meterRow}>
                    <span className={styles.meterLabel}>
                      {t('usage.sub_quota', { period: formatPeriod(subscription.quota.periodMs) })}
                    </span>
                    <span className={styles.meter} aria-hidden="true">
                      <span
                        className={styles.meterFill}
                        style={{ width: `${Math.min(usedPercent ?? 0, 100)}%` }}
                      />
                    </span>
                    <span className={styles.meterValue}>
                      {usedPercent === null
                        ? '—'
                        : t('usage.sub_used', { percent: formatPercent(usedPercent, 0) })}
                    </span>
                  </span>
                  <span className={styles.quotaMeta}>
                    {subscription.session && sessionUsedPercent !== null && (
                      <span>
                        {t('usage.sub_session', {
                          period: formatPeriod(subscription.session.periodMs),
                          percent: formatPercent(sessionUsedPercent, 0),
                        })}
                      </span>
                    )}
                    {observedAtMs !== null && (
                      <span>
                        {usedPercent === null
                          ? t('usage.sub_no_reading', {
                              relative: formatRelativeInstant(observedAtMs, nowMs, locale),
                            })
                          : t('usage.sub_observed', {
                              relative: formatRelativeInstant(observedAtMs, nowMs, locale),
                            })}
                      </span>
                    )}
                  </span>
                </span>
              ) : (
                <span className={styles.noWindow}>{t('usage.sub_no_window')}</span>
              )}

              <span className={styles.spend}>
                <span className={styles.spendHead}>
                  <span className={styles.spendValue}>{formatUsd(summary.costUsd, locale)}</span>
                  <span className={styles.spendLabel}>
                    {window ? t('usage.sub_spend_window') : t('usage.sub_spend_selection')}
                  </span>
                  {summary.estimateUsd !== null && (
                    <span
                      className={styles.estimate}
                      title={t('usage.sub_estimate_hint', {
                        percent: formatPercent(usedPercent ?? 0, 0),
                      })}
                    >
                      {t('usage.sub_estimate', {
                        amount: formatUsd(summary.estimateUsd, locale, true),
                      })}
                    </span>
                  )}
                </span>
                {summary.costUsd > 0 ? (
                  <>
                    <span className={styles.split} aria-hidden="true">
                      {summary.users.map((user) => (
                        <span
                          key={user.user || '\u0000'}
                          className={`${styles.splitPart} ${slotClassName(userSlots.get(user.user) ?? 'other')}`}
                          style={{ flexGrow: user.costUsd }}
                        />
                      ))}
                    </span>
                    <span className={styles.splitLegend}>
                      {named.map((user) => (
                        <span key={user.user || '\u0000'} className={styles.splitItem}>
                          <span
                            className={`${styles.swatch} ${slotClassName(userSlots.get(user.user) ?? 'other')}`}
                            aria-hidden="true"
                          />
                          {userLabel(user.user)}
                          <b>{formatUsd(user.costUsd, locale)}</b>
                        </span>
                      ))}
                      {rest > 0 && (
                        <span className={styles.splitItem}>
                          {t('usage.sub_more_users', { count: rest })}
                        </span>
                      )}
                    </span>
                  </>
                ) : (
                  <span className={styles.idle}>{t('usage.sub_idle')}</span>
                )}
              </span>
            </>
          );

          return (
            <li key={subscription.id}>
              {window ? (
                <button
                  type="button"
                  className={`${styles.card} ${styles.cardButton}`}
                  aria-pressed={activeId === subscription.id}
                  title={t('usage.sub_open')}
                  onClick={() => onSelect(subscription.id)}
                >
                  {body}
                </button>
              ) : (
                <div className={`${styles.card} ${styles.cardStatic}`}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      {unattributedUsd > 0 && (
        <p className={styles.unattributed}>
          <span className={`${styles.swatch} ${slotClassName('none')}`} aria-hidden="true" />
          {t('usage.unattributed_note', { amount: formatUsd(unattributedUsd, locale) })}
        </p>
      )}
    </>
  );
}
