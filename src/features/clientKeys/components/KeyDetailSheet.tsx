import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Sheet } from '@/components/ui/Sheet';
import { Skeleton } from '@/components/ui/Skeleton';
import type { ClientKey } from '@/services/api/clientKeys';
import { UsageSpendChart } from '@/features/usage/components/UsageSpendChart';
import { formatUsd } from '@/features/usage/usageModel';
import { formatCompactNumber } from '@/utils/format';
import {
  SPEND_SERIES,
  USAGE_RANGES,
  keyStatus,
  stackUsageByDay,
  type UsageRangeId,
} from '../clientKeysModel';
import { useKeyUsage } from '../hooks/useKeyUsage';
import { BudgetBar, CredentialsBadge, ModelChips, StatusBadge, UnpricedBadge } from './KeyBits';
import styles from './KeyDetailSheet.module.scss';

interface KeyDetailSheetProps {
  keyEntry: ClientKey;
  nowMs: number;
  onClose: () => void;
}

/** One key: its settings, this month's budget, and its usage by day and by model. */
export function KeyDetailSheet({ keyEntry, nowMs, onClose }: KeyDetailSheetProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const [range, setRange] = useState<UsageRangeId>('month');
  const { usage, window, ledgerOff, error, loading } = useKeyUsage(keyEntry.id, range);

  const formatDateTime = (ms: number | null) =>
    ms === null
      ? t('client_keys.never')
      : new Date(ms).toLocaleString(locale, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });

  const tokens = usage
    ? usage.byModel.reduce(
        (sum, row) =>
          sum + row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens,
        0
      )
    : 0;
  const requests = usage ? usage.byModel.reduce((sum, row) => sum + row.requests, 0) : 0;
  const isUnpriced = (model: string) =>
    usage?.unpriced.some((label) => label === model || label.startsWith(`${model} (`)) ?? false;
  const rangeLabel = t(`client_keys.range_${range}`);

  const facts: Array<[string, ReactNode]> = [
    [t('client_keys.col_status'), <StatusBadge status={keyStatus(keyEntry, nowMs)} />],
    [t('client_keys.fact_prefix'), <code className={styles.mono}>{keyEntry.prefix}</code>],
    [t('client_keys.col_project'), keyEntry.project || t('client_keys.no_project')],
    [t('client_keys.col_credentials'), <CredentialsBadge credentials={keyEntry.credentials} />],
    [t('client_keys.col_models'), <ModelChips models={keyEntry.models} all />],
    [t('client_keys.col_expires'), formatDateTime(keyEntry.expiresAtMs)],
    [t('client_keys.col_created'), formatDateTime(keyEntry.createdAtMs)],
    [t('client_keys.fact_updated'), formatDateTime(keyEntry.updatedAtMs)],
    [t('client_keys.fact_id'), <code className={styles.mono}>{keyEntry.id}</code>],
  ];

  return (
    <Sheet
      open
      onClose={onClose}
      size="lg"
      eyebrow={keyEntry.project || t('client_keys.no_project')}
      title={keyEntry.name}
      description={t('client_keys.detail_description')}
    >
      <div className={styles.body}>
        <section className={styles.block} aria-labelledby="ck-budget-title">
          <div className={styles.blockHead}>
            <h3 id="ck-budget-title" className={styles.blockTitle}>
              {t('client_keys.detail_budget_title')}
            </h3>
            <UnpricedBadge keyEntry={keyEntry} />
          </div>
          <BudgetBar keyEntry={keyEntry} wide />
        </section>

        <dl className={styles.facts}>
          {facts.map(([label, value]) => (
            <div key={label} className={styles.fact}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>

        <section className={styles.block} aria-labelledby="ck-usage-title">
          <div className={styles.blockHead}>
            <h3 id="ck-usage-title" className={styles.blockTitle}>
              {t('client_keys.detail_usage_title')}
            </h3>
            <div
              className={styles.segmented}
              role="group"
              aria-label={t('client_keys.range_label')}
            >
              {USAGE_RANGES.map((id) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={range === id}
                  onClick={() => setRange(id)}
                >
                  {t(`client_keys.range_${id}`)}
                </button>
              ))}
            </div>
          </div>

          {ledgerOff ? (
            <p className={styles.notice}>{t('client_keys.ledger_off_usage')}</p>
          ) : error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : !usage || !window ? (
            <div className={styles.skeletons} aria-hidden="true">
              <Skeleton height={64} rounded={12} />
              <Skeleton height={260} rounded={12} />
            </div>
          ) : (
            <div
              className={loading ? `${styles.usage} ${styles.stale}` : styles.usage}
              aria-busy={loading}
            >
              <div className={styles.stats}>
                <div className={styles.stat}>
                  <span className={styles.statLabel}>{t('client_keys.stat_spend')}</span>
                  <span className={styles.statValue}>{formatUsd(usage.totalUsd, locale)}</span>
                </div>
                <div className={styles.stat}>
                  <span className={styles.statLabel}>{t('client_keys.stat_requests')}</span>
                  <span className={styles.statValue}>{requests.toLocaleString(locale)}</span>
                </div>
                <div className={styles.stat}>
                  <span className={styles.statLabel}>{t('client_keys.stat_tokens')}</span>
                  <span className={styles.statValue}>{formatCompactNumber(tokens)}</span>
                </div>
              </div>

              <UsageSpendChart
                stacked={stackUsageByDay(usage.byDay, window)}
                series={[{ key: SPEND_SERIES, slot: 0, label: t('client_keys.stat_spend') }]}
                span={window.span}
                unit={window.unit}
                nowMs={nowMs}
                showFuture
                markers={[]}
                summary={t('client_keys.chart_summary', {
                  name: keyEntry.name,
                  range: rangeLabel,
                  amount: formatUsd(usage.totalUsd, locale),
                })}
              />

              {usage.unpriced.length > 0 && (
                <p className={styles.notice}>
                  {t('client_keys.unpriced_models_note', { models: usage.unpriced.join(', ') })}
                </p>
              )}

              {usage.byModel.length === 0 ? (
                <p className={styles.empty}>{t('client_keys.usage_empty')}</p>
              ) : (
                <div className={styles.scroller}>
                  <table className={styles.table}>
                    <caption className={styles.caption}>
                      {t('client_keys.by_model_title', { range: rangeLabel })}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('client_keys.col_model')}</th>
                        <th scope="col" className={styles.num}>
                          {t('client_keys.stat_requests')}
                        </th>
                        <th scope="col" className={styles.num}>
                          {t('client_keys.col_input')}
                        </th>
                        <th scope="col" className={styles.num}>
                          {t('client_keys.col_output')}
                        </th>
                        <th scope="col" className={styles.num}>
                          {t('client_keys.col_cache')}
                        </th>
                        <th scope="col" className={styles.num}>
                          {t('client_keys.stat_spend')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.byModel.map((row) => (
                        <tr key={row.model}>
                          <th scope="row">
                            <span className={styles.mono}>{row.model}</span>
                            {isUnpriced(row.model) && (
                              <span className={styles.unpriced}>
                                {t('client_keys.unpriced_badge')}
                              </span>
                            )}
                          </th>
                          <td className={styles.num}>{row.requests.toLocaleString(locale)}</td>
                          <td className={styles.num}>{formatCompactNumber(row.inputTokens)}</td>
                          <td className={styles.num}>{formatCompactNumber(row.outputTokens)}</td>
                          <td className={styles.num}>
                            {formatCompactNumber(row.cacheReadTokens + row.cacheWriteTokens)}
                          </td>
                          <td className={`${styles.num} ${styles.spend}`}>
                            {isUnpriced(row.model) ? '—' : formatUsd(row.costUsd, locale)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </Sheet>
  );
}
