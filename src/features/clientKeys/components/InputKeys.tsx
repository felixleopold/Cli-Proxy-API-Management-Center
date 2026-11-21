import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { IconPencil } from '@/components/ui/icons';
import { getAuthFileIcon } from '@/features/authFiles/constants';
import { formatUsd } from '@/features/usage/usageModel';
import type { InputKey } from '@/services/api/inputKeys';
import { useThemeStore } from '@/stores';
import { inputKeyLabel, inputKeyLimit, inputKeyScope, sortInputKeys } from '../inputKeysModel';
import bits from './KeyBits.module.scss';
import styles from './InputKeys.module.scss';

interface InputKeysProps {
  keys: InputKey[];
  error: string;
  onEdit: (key: InputKey) => void;
}

/** Upstream API keys: who may use each, its credential groups and its spend this cycle. */
export function InputKeys({ keys, error, onEdit }: InputKeysProps) {
  const { t } = useTranslation();
  const sorted = useMemo(() => sortInputKeys(keys), [keys]);

  if (error && keys.length === 0) {
    return (
      <p className={styles.empty} role="alert">
        {t('input_keys.load_error', { error })}
      </p>
    );
  }
  if (keys.length === 0) return <p className={styles.empty}>{t('input_keys.empty')}</p>;

  return (
    <ul className={styles.list}>
      {sorted.map((key) => (
        <InputKeyRow key={key.id} entry={key} onEdit={onEdit} />
      ))}
    </ul>
  );
}

function InputKeyRow({ entry, onEdit }: { entry: InputKey; onEdit: (key: InputKey) => void }) {
  const { t } = useTranslation();
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const icon = getAuthFileIcon(entry.provider, resolvedTheme);
  const label = inputKeyLabel(entry);
  const scope = inputKeyScope(entry);

  return (
    <li className={entry.disabled ? `${styles.row} ${styles.rowDisabled}` : styles.row}>
      <div className={styles.identity}>
        {icon ? (
          <img src={icon} alt="" className={styles.icon} />
        ) : (
          <span className={styles.iconFallback} aria-hidden="true" />
        )}
        <div className={styles.names}>
          <span className={styles.name} title={entry.id}>
            {label}
          </span>
          <span className={styles.provider}>
            {entry.provider}
            {entry.disabled && (
              <span className={styles.disabled}> · {t('input_keys.disabled')}</span>
            )}
          </span>
        </div>
      </div>

      <div className={styles.scope}>
        <span
          className={`${styles.scopeBadge} ${styles[`scope_${scope}`]}`}
          title={t(`input_keys.scope_${scope}_hint`)}
        >
          {t(`input_keys.scope_${scope}`)}
        </span>
        {entry.credentialGroups.map((group) => (
          <span key={group} className={styles.group} title={t('input_keys.group_hint')}>
            {group}
          </span>
        ))}
      </div>

      <CycleSpend entry={entry} />

      <Button
        variant="secondary"
        size="sm"
        className={styles.edit}
        onClick={() => onEdit(entry)}
        aria-label={t('input_keys.edit_label', { name: label })}
      >
        <IconPencil size={14} />
        {t('input_keys.edit')}
      </Button>
    </li>
  );
}

/** Spend in the current cycle against the monthly limit, with the cycle's anchor below. */
function CycleSpend({ entry }: { entry: InputKey }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const { level, ratio } = inputKeyLimit(entry);
  const spent = entry.spentUsdCycle === null ? '—' : formatUsd(entry.spentUsdCycle, locale);
  const limit = formatUsd(entry.monthlyLimitUsd, locale);
  const since =
    entry.cycleStartMs === null
      ? null
      : new Date(entry.cycleStartMs).toLocaleDateString(locale, {
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC',
        });
  const anchor = since
    ? t('input_keys.cycle_since', { day: entry.billingCycleDay, date: since })
    : t('input_keys.cycle_day', { day: entry.billingCycleDay });
  const meterLabel = t('input_keys.spend_label', {
    spent,
    limit,
    percent: Math.round((ratio ?? 0) * 100),
  });

  return (
    <div className={`${bits.budget} ${bits[`level_${level}`] ?? ''} ${styles.spend}`}>
      <span className={bits.budgetText}>
        <b>{spent}</b>
        {entry.unpricedUsageCycle && (
          <span className={styles.unpriced} title={t('input_keys.unpriced_hint')}>
            *
          </span>
        )}
        <span className={bits.budgetMuted}>
          {level === 'unlimited' ? `· ${t('input_keys.no_limit')}` : `/ ${limit}`}
        </span>
        {level === 'over' && (
          <span className={styles.limitFlag} title={t('input_keys.limit_reached_hint')}>
            {t('input_keys.limit_reached')}
          </span>
        )}
        {level === 'near' && (
          <span className={bits.budgetFlag}>{t('client_keys.budget_near')}</span>
        )}
      </span>
      {level !== 'unlimited' && (
        <span
          className={bits.track}
          role="meter"
          aria-label={meterLabel}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round((ratio ?? 0) * 100)}
        >
          <span className={bits.fill} style={{ width: `${(ratio ?? 0) * 100}%` }} />
        </span>
      )}
      <span className={styles.anchor}>{anchor}</span>
    </div>
  );
}
