import { useTranslation } from 'react-i18next';
import { formatUsd } from '@/features/usage/usageModel';
import type { ClientKeysOverview } from '../clientKeysModel';
import styles from './Overview.module.scss';

/** Four KPI cells: keys, this month's spend against budgets, budget alerts, unpriced usage. */
export function Overview({ overview }: { overview: ClientKeysOverview }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const { byStatus } = overview;
  const alerts = overview.near + overview.over;

  const statusParts = [
    t('client_keys.overview_active', { count: byStatus.active }),
    ...(byStatus.disabled > 0
      ? [t('client_keys.overview_disabled', { count: byStatus.disabled })]
      : []),
    ...(byStatus.expired > 0
      ? [t('client_keys.overview_expired', { count: byStatus.expired })]
      : []),
  ];

  return (
    <div className={styles.stats} role="group" aria-label={t('client_keys.overview_label')}>
      <div className={styles.stat}>
        <span className={styles.label}>{t('client_keys.overview_keys')}</span>
        <span className={styles.value}>{overview.total}</span>
        <span className={styles.hint}>{statusParts.join(' · ')}</span>
      </div>

      <div className={styles.stat}>
        <span className={styles.label}>{t('client_keys.overview_spend')}</span>
        {overview.spentUsd === null ? (
          <>
            <span className={styles.value}>—</span>
            <span className={styles.hint}>{t('client_keys.overview_spend_off')}</span>
          </>
        ) : (
          <>
            <span className={styles.value}>
              {formatUsd(overview.spentUsd, locale)}
              {overview.budgetUsd > 0 && (
                <span className={styles.valueMuted}>
                  {' '}
                  / {formatUsd(overview.budgetUsd, locale)}
                </span>
              )}
            </span>
            <span className={styles.hint}>
              {overview.budgetUsd > 0
                ? t('client_keys.overview_spend_hint', { count: overview.unlimited })
                : t('client_keys.overview_spend_no_budgets')}
            </span>
          </>
        )}
      </div>

      <div className={styles.stat}>
        <span className={styles.label}>{t('client_keys.overview_alerts')}</span>
        <span className={alerts > 0 ? `${styles.value} ${styles.valueAlert}` : styles.value}>
          {alerts}
        </span>
        <span className={styles.hint}>
          {alerts > 0
            ? t('client_keys.overview_alerts_hint', { over: overview.over, near: overview.near })
            : t('client_keys.overview_alerts_none')}
        </span>
      </div>

      <div className={styles.stat}>
        <span className={styles.label}>{t('client_keys.overview_unpriced')}</span>
        <span
          className={overview.unpriced > 0 ? `${styles.value} ${styles.valueWarn}` : styles.value}
        >
          {overview.unpriced}
        </span>
        <span className={styles.hint}>
          {overview.unpriced > 0
            ? t('client_keys.overview_unpriced_hint')
            : t('client_keys.overview_unpriced_none')}
        </span>
      </div>
    </div>
  );
}
