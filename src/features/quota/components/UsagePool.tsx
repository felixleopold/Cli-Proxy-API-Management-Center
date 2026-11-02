/**
 * Pooled usage from the gateway's usage reserves: per provider and window the
 * pool size and what is left (for a chosen person too), the burn forecast, the
 * refills ahead and each account's lender reserve; plus the person's override.
 * Values come from GET /usage/pool (usagePoolModel.ts); this file is layout.
 */

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { getAuthFileIcon, getTypeLabel } from '@/features/authFiles/constants';
import { useLedgerUsers } from '@/features/usage/hooks/useLedgerUsers';
import { useNow } from '@/hooks/useNow';
import { useNotificationStore } from '@/stores';
import type { UsagePoolReport, UsagePoolWindow } from '@/services/api/usagePool';
import type { AuthFileItem, ResolvedTheme } from '@/types';
import { formatMultiplier } from '../planMultipliers';
import { bindQuotaClasses } from '../types';
import {
  activeOverrideUntil,
  formatPoolTime,
  poolProviders,
  reserveStateOf,
  upcomingRefills,
} from '../usagePoolModel';
import { useUsagePool } from '../hooks/useUsagePool';
import { QuotaMeter } from './QuotaMeter';
import bodyStyles from './QuotaBody.module.scss';
import styles from './UsagePool.module.scss';

const quotaClasses = bindQuotaClasses(bodyStyles, 'QuotaBody.module.scss');
const percent = (value: number) => Math.round(value);

export function UsagePool({
  files,
  tab,
  resolvedTheme,
}: {
  files: AuthFileItem[];
  tab: string;
  resolvedTheme: ResolvedTheme;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const language = i18n.resolvedLanguage;
  const showNotification = useNotificationStore((store) => store.showNotification);
  const users = useLedgerUsers();
  const [user, setUser] = useState('');
  const providers = poolProviders(files, tab);
  const { reports, supported, error, saving, setOverride } = useUsagePool(providers, user);
  const nowMs = useNow();

  if (!supported || providers.length === 0) return null;

  const x = (value: number) => formatMultiplier(value, language);
  const when = (atMs: number) => formatPoolTime(atMs, nowMs, language);
  const person = reports.find((report) => report.user)?.user ?? null;
  const overrideUntil = activeOverrideUntil(person, nowMs);
  const stopped = reports.filter((report) => report.user?.softStopped);

  const toggleOverride = async (on: boolean) => {
    try {
      await setOverride(on);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('common.unknown_error');
      showNotification(t('usage_pool.override_failed', { message }), 'error');
    }
  };

  let personStatus = '';
  if (person) {
    if (overrideUntil !== null) {
      personStatus = t('usage_pool.person_override_until', { time: when(overrideUntil) });
    } else if (person.reservePercent <= 0) {
      personStatus = t('usage_pool.person_no_reserve');
    } else if (stopped.length > 0) {
      personStatus = t('usage_pool.person_stopped', {
        providers: stopped.map((report) => getTypeLabel(t, report.provider)).join(', '),
      });
    } else {
      personStatus = t('usage_pool.person_using');
    }
  }

  return (
    <section className={styles.pool} aria-labelledby={`${id}-title`}>
      <header className={styles.head}>
        <div className={styles.headCopy}>
          <h3 id={`${id}-title`} className={styles.title}>
            {t('usage_pool.title')}
          </h3>
          <p className={styles.description}>{t('usage_pool.description')}</p>
        </div>
        <div className={styles.personPicker}>
          <Select
            value={user}
            options={[
              { value: '', label: t('usage_pool.person_everyone') },
              ...users.map((name) => ({ value: name, label: name })),
            ]}
            onChange={setUser}
            ariaLabel={t('usage_pool.person_label')}
            size="sm"
          />
        </div>
      </header>

      {person && (
        <div
          className={`${styles.personBar} ${
            overrideUntil === null && stopped.length > 0 ? styles.personStopped : ''
          }`}
        >
          <div className={styles.personCopy}>
            <strong>
              {person.reservePercent > 0
                ? t('usage_pool.person_reserve', {
                    name: person.name,
                    percent: person.reservePercent,
                  })
                : person.name}
            </strong>
            <span>{personStatus}</span>
          </div>
          {person.reservePercent > 0 && (
            <label className={styles.override}>
              <span>{t('usage_pool.override_label')}</span>
              <ToggleSwitch
                checked={overrideUntil !== null}
                onChange={(on) => void toggleOverride(on)}
                disabled={saving}
                ariaLabel={t('usage_pool.override_aria', { name: person.name })}
              />
            </label>
          )}
        </div>
      )}

      {error && (
        <p className={styles.error} role="alert">
          {t('usage_pool.load_failed', { message: error })}
        </p>
      )}

      <div className={styles.providers}>
        {reports.map((report) => (
          <ProviderPool
            key={report.provider}
            report={report}
            resolvedTheme={resolvedTheme}
            scoped={Boolean(person)}
            t={t}
            x={x}
            when={when}
            nowMs={nowMs}
          />
        ))}
      </div>
    </section>
  );
}

function ProviderPool({
  report,
  resolvedTheme,
  scoped,
  t,
  x,
  when,
  nowMs,
}: {
  report: UsagePoolReport;
  resolvedTheme: ResolvedTheme;
  scoped: boolean;
  t: TFunction;
  x: (value: number) => string;
  when: (atMs: number) => string;
  nowMs: number;
}) {
  const iconSrc = getAuthFileIcon(report.provider, resolvedTheme);
  const label = getTypeLabel(t, report.provider);
  const windows = report.windows.filter((pool) => pool.capacity > 0);
  return (
    <article className={styles.provider} aria-label={label}>
      <header className={styles.providerHead}>
        {iconSrc && <img src={iconSrc} alt="" className={styles.providerIcon} />}
        <span className={styles.providerName}>{label}</span>
        {report.activeAccount && (
          <span className={styles.active} title={report.activeAccount.id}>
            {t('usage_pool.active_account', {
              label: report.activeAccount.label || report.activeAccount.id,
            })}
          </span>
        )}
      </header>
      {windows.length === 0 ? (
        <p className={styles.muted}>{t('usage_pool.no_accounts')}</p>
      ) : (
        windows.map((pool) => (
          <PoolWindow
            key={pool.kind}
            pool={pool}
            scoped={scoped}
            t={t}
            x={x}
            when={when}
            nowMs={nowMs}
          />
        ))
      )}
    </article>
  );
}

function PoolWindow({
  pool,
  scoped,
  t,
  x,
  when,
  nowMs,
}: {
  pool: UsagePoolWindow;
  scoped: boolean;
  t: TFunction;
  x: (value: number) => string;
  when: (atMs: number) => string;
  nowMs: number;
}) {
  const { refills, total } = upcomingRefills(pool, nowMs);
  const next = refills[0];
  const windowName = t(pool.kind === 'weekly' ? 'usage_pool.weekly' : 'usage_pool.five_hour');

  let forecast = t('usage_pool.forecast_unknown');
  if (pool.emptyAtMs !== null) {
    forecast = t('usage_pool.forecast_empty', { time: when(pool.emptyAtMs) });
  } else if (pool.burnPerHour !== null && pool.burnPerHour > 0) {
    forecast = t('usage_pool.forecast_lasts');
  } else if (pool.burnPerHour !== null) {
    forecast = t('usage_pool.forecast_idle');
  }

  return (
    <div className={styles.pool}>
      <div className={styles.windowHead}>
        <span className={styles.windowName}>{windowName}</span>
        <span className={styles.windowSize}>
          {t('usage_pool.pool_size', { value: x(pool.capacity) })}
        </span>
      </div>
      <div className={styles.headline}>
        <strong className={styles.value}>{x(pool.left)}</strong>
        <span className={styles.caption}>
          {t('usage_pool.left', { percent: percent(pool.leftPercent) })}
        </span>
        {scoped && (
          <span className={styles.forPerson}>
            {t('usage_pool.left_for_person', { percent: percent(pool.leftForUserPercent) })}
          </span>
        )}
      </div>
      <QuotaMeter percent={pool.leftPercent} classes={quotaClasses} />
      <p className={styles.facts}>
        {pool.burnPerHour !== null && (
          <span>{t('usage_pool.burn', { value: x(pool.burnPerHour) })}</span>
        )}
        <span>{forecast}</span>
        {next && (
          <span>
            {refills.length > 1
              ? t('usage_pool.refills_next_more', {
                  value: x(next.units),
                  time: when(next.atMs),
                  total: x(total),
                  n: refills.length,
                })
              : t('usage_pool.refills_next', { value: x(next.units), time: when(next.atMs) })}
          </span>
        )}
      </p>
      <details className={styles.accounts}>
        <summary>{t('usage_pool.accounts_summary', { count: pool.accounts.length })}</summary>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('usage_pool.col_account')}</th>
              <th scope="col">{t('usage_pool.col_weight')}</th>
              <th scope="col">{t('usage_pool.col_used')}</th>
              <th scope="col">{t('usage_pool.col_reserve')}</th>
              <th scope="col">{t('usage_pool.col_resets')}</th>
            </tr>
          </thead>
          <tbody>
            {pool.accounts.map((account) => {
              const state = reserveStateOf(account);
              return (
                <tr key={account.id}>
                  <th scope="row" className={styles.accountName} title={account.id}>
                    {account.label || account.id}
                    {account.lender && (
                      <span className={styles.lender}>
                        {t('usage_pool.lent_by', { name: account.lender })}
                      </span>
                    )}
                  </th>
                  <td>
                    {account.plan ? `${account.plan} · ${x(account.weight)}` : x(account.weight)}
                  </td>
                  <td>{percent(account.usedPercent)}%</td>
                  <td>
                    {state === 'none' ? (
                      '–'
                    ) : (
                      <span className={`${styles.reserve} ${styles[`reserve_${state}`]}`}>
                        {t(`usage_pool.reserve_${state}`, { percent: account.reservePercent })}
                      </span>
                    )}
                  </td>
                  <td>{account.resetAtMs !== null ? when(account.resetAtMs) : '–'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>
    </div>
  );
}
