import { useTranslation } from 'react-i18next';
import { formatPercent } from '@/utils/format';
import { formatUsd, type SeriesSlot, type SubscriptionSummary } from '../usageModel';
import { slotClassName } from './slotClass';
import styles from './AccountSpend.module.scss';

/** Named users shown under the split bar before the rest are counted. */
const SPLIT_LEGEND_COUNT = 3;

/** What the account cards need from the ledger, handed out by UsageSections. */
export interface AccountSpendContext {
  /** 'unavailable' when the ledger is disabled or failed (the spend history says why). */
  status: 'loading' | 'ready' | 'unavailable';
  /** A longer span is loading; the spend shown stays, dimmed. */
  stale: boolean;
  /** Spend per credential for the provider filter, windows first. */
  summaries: SubscriptionSummary[];
  userSlots: Map<string, SeriesSlot>;
  /** The credential whose window the spend history shows. */
  activeId: string | null;
  userLabel: (user: string) => string;
  /** The history range, which credentials without a window fall back to (e.g. "Last 7 days"). */
  rangeName: string;
  rangeSpan: string;
  onSelect: (id: string) => void;
}

interface AccountSpendProps {
  summary: SubscriptionSummary | null;
  context: AccountSpendContext;
}

/**
 * The spend row of an account card: spend in the credential's current window
 * (or the history range without one), ≈ spend at 100% and the split by user.
 * With a window, the row swaps the spend history to that window.
 */
export function AccountSpend({ summary, context }: AccountSpendProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;

  if (context.status === 'loading') {
    return (
      <div className={styles.spend} aria-hidden="true">
        <span className={styles.placeholder} />
        <span className={`${styles.placeholder} ${styles.placeholderShort}`} />
      </div>
    );
  }
  if (context.status === 'unavailable' || !summary) return null;

  const { subscription, window, usedPercent } = summary;
  const { userSlots, userLabel } = context;
  const named = summary.users.slice(0, SPLIT_LEGEND_COUNT);
  const rest = summary.users.length - named.length;
  const formatInstant = (ms: number) =>
    new Date(ms).toLocaleString(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  const content = (
    <>
      <span className={styles.spendHead}>
        <span className={styles.spendValue}>{formatUsd(summary.costUsd, locale)}</span>
        <span className={styles.spendLabel}>
          {window ? t('usage.sub_spend_window') : t('usage.sub_spend_range')}
        </span>
        {summary.estimateUsd !== null && (
          <span
            className={styles.estimate}
            title={t('usage.sub_estimate_hint', { percent: formatPercent(usedPercent ?? 0, 0) })}
          >
            {t('usage.sub_estimate', { amount: formatUsd(summary.estimateUsd, locale, true) })}
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
              <span className={styles.splitItem}>{t('usage.sub_more_users', { count: rest })}</span>
            )}
          </span>
        </>
      ) : (
        <span className={styles.idle}>{t('usage.sub_idle')}</span>
      )}
    </>
  );

  return (
    <div
      className={`${styles.spend} ${context.stale ? styles.stale : ''}`}
      aria-busy={context.stale || undefined}
    >
      {window ? (
        <button
          type="button"
          className={styles.spendButton}
          aria-pressed={context.activeId === subscription.id}
          title={`${t('usage.sub_open')} · ${formatInstant(window.startMs)} – ${formatInstant(window.endMs)}`}
          onClick={() => context.onSelect(subscription.id)}
        >
          {content}
        </button>
      ) : (
        <div className={styles.spendStatic}>
          <span className={styles.noWindow}>
            {t('usage.sub_no_window', { range: context.rangeName, span: context.rangeSpan })}
          </span>
          {content}
        </div>
      )}
    </div>
  );
}
