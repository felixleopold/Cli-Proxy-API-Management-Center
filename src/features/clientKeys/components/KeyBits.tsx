import { useTranslation } from 'react-i18next';
import type { ClientKey } from '@/services/api/clientKeys';
import { formatUsd } from '@/features/usage/usageModel';
import { budgetState, unpricedBlocksKey, type KeyStatus } from '../clientKeysModel';
import styles from './KeyBits.module.scss';

/** Small key facts shared by the list and the detail sheet. */

export function StatusBadge({ status }: { status: KeyStatus }) {
  const { t } = useTranslation();
  return (
    <span className={`${styles.status} ${styles[`status_${status}`]}`}>
      <span className={styles.statusDot} aria-hidden="true" />
      {t(`client_keys.status_${status}`)}
    </span>
  );
}

export function CredentialsBadge({ credentials }: { credentials: ClientKey['credentials'] }) {
  const { t } = useTranslation();
  return (
    <span
      className={`${styles.credentials} ${credentials === 'any' ? styles.credentialsAny : ''}`}
      title={t(`client_keys.credentials_${credentials === 'any' ? 'any' : 'api_key'}_hint`)}
    >
      {credentials}
    </span>
  );
}

const MAX_CHIPS = 2;

export function ModelChips({ models, all = false }: { models: string[]; all?: boolean }) {
  const { t } = useTranslation();
  if (models.length === 0)
    return <span className={styles.allModels}>{t('client_keys.models_all')}</span>;
  const shown = all ? models : models.slice(0, MAX_CHIPS);
  const rest = models.length - shown.length;
  return (
    <span className={styles.chips} title={all ? undefined : models.join(', ')}>
      {shown.map((model) => (
        <span key={model} className={styles.chip}>
          {model}
        </span>
      ))}
      {rest > 0 && <span className={styles.more}>+{rest}</span>}
    </span>
  );
}

export function UnpricedBadge({ keyEntry }: { keyEntry: ClientKey }) {
  const { t } = useTranslation();
  if (!keyEntry.unpricedUsageMonth) return null;
  const blocked = unpricedBlocksKey(keyEntry);
  return (
    <span
      className={`${styles.flag} ${blocked ? styles.flagBlocking : ''}`}
      title={t(blocked ? 'client_keys.unpriced_blocked_hint' : 'client_keys.unpriced_hint')}
    >
      {t('client_keys.unpriced_badge')}
    </span>
  );
}

/** Spent against the monthly budget: a bar in ink, amber from 80 %, red once exhausted. */
export function BudgetBar({ keyEntry, wide = false }: { keyEntry: ClientKey; wide?: boolean }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const budget = budgetState(keyEntry);
  const spent = budget.spentUsd === null ? '—' : formatUsd(budget.spentUsd, locale);

  if (budget.level === 'unlimited') {
    return (
      <span className={`${styles.budget} ${wide ? styles.budgetWide : ''}`}>
        <span className={styles.budgetText}>
          <b>{spent}</b>
          <span className={styles.budgetMuted}>{t('client_keys.budget_unlimited')}</span>
        </span>
      </span>
    );
  }

  const percent = budget.ratio === null ? 0 : Math.min(100, budget.ratio * 100);
  const label =
    budget.level === 'untracked'
      ? t('client_keys.budget_untracked_label', { budget: formatUsd(budget.budgetUsd, locale) })
      : t('client_keys.budget_label', {
          spent,
          budget: formatUsd(budget.budgetUsd, locale),
          percent: Math.round((budget.ratio ?? 0) * 100),
        });

  return (
    <span
      className={`${styles.budget} ${styles[`level_${budget.level}`]} ${wide ? styles.budgetWide : ''}`}
      title={label}
    >
      <span className={styles.budgetText}>
        <b>{spent}</b>
        <span className={styles.budgetMuted}>/ {formatUsd(budget.budgetUsd, locale)}</span>
        {budget.level === 'over' && (
          <span className={styles.budgetFlag}>{t('client_keys.budget_over')}</span>
        )}
        {budget.level === 'near' && (
          <span className={styles.budgetFlag}>{t('client_keys.budget_near')}</span>
        )}
        {budget.level === 'untracked' && (
          <span className={styles.budgetFlag}>{t('client_keys.budget_untracked')}</span>
        )}
      </span>
      <span
        className={styles.track}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <span className={styles.fill} style={{ width: `${percent}%` }} />
      </span>
    </span>
  );
}
