/**
 * Plan multipliers on the Usage & quota page: the per-provider totals above the
 * account cards, and each card's plan badge and headline. Values come from
 * planMultipliers.ts and quotaForecastModel.ts; this file is layout only.
 */

import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ResolvedTheme } from '@/types';
import { getAuthFileIcon, getTypeLabel } from '@/features/authFiles/constants';
import type { ProviderMultipliers } from '../quotaForecastModel';
import {
  formatMultiplier,
  shareLeft,
  type AccountMultiplier,
  type PlanShare,
} from '../planMultipliers';
import { bindQuotaClasses } from '../types';
import { QuotaMeter } from './QuotaMeter';
import bodyStyles from './QuotaBody.module.scss';
import styles from './PlanMultipliers.module.scss';

const quotaClasses = bindQuotaClasses(bodyStyles, 'QuotaBody.module.scss');

const percentOf = (remaining: number, of: number) =>
  Math.round((shareLeft(remaining, of) ?? 0) * 100);

/** "5-hour" for a 300-minute window. */
const windowName = (t: TFunction, minutes: number, language?: string) =>
  t('quota_management.multiplier_window_hours', {
    hours: new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(minutes / 60),
  });

export function PlanMultiplierTotals({
  providers,
  resolvedTheme,
}: {
  providers: ProviderMultipliers[];
  resolvedTheme: ResolvedTheme;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage;
  if (providers.length === 0) return null;
  const x = (value: number) => formatMultiplier(value, language);

  return (
    <div
      className={styles.totals}
      role="group"
      aria-label={t('quota_management.multiplier_totals_label')}
    >
      {providers.map(({ provider, multipliers }) => {
        const { totals, weekly, short } = multipliers;
        const iconSrc = getAuthFileIcon(provider, resolvedTheme);
        const label = getTypeLabel(t, provider);
        // Without any reading, plans and our share are known but what is left is not.
        const read = totals.readEffective > 0;
        const percent = percentOf(totals.remaining, totals.readEffective);
        return (
          <article key={provider} className={styles.tile} aria-label={label}>
            <header className={styles.tileHead}>
              {iconSrc && <img src={iconSrc} alt="" className={styles.tileIcon} />}
              <span className={styles.tileName}>{label}</span>
              <span className={styles.tilePlans}>
                {t('quota_management.multiplier_plans_ours', {
                  plans: x(totals.plans),
                  ours: x(totals.effective),
                })}
              </span>
            </header>
            <div className={styles.tileHeadline}>
              <strong className={styles.tileValue}>{read ? x(totals.remaining) : '–'}</strong>
              <span className={styles.tileCaption}>
                {!read
                  ? t('quota_management.multiplier_left_unavailable')
                  : weekly
                    ? t('quota_management.multiplier_left_week')
                    : t('quota_management.multiplier_left_window')}
              </span>
            </div>
            <QuotaMeter percent={read ? percent : null} classes={quotaClasses} />
            <p className={styles.tileFacts}>
              {read && (
                <span>
                  {t('quota_management.multiplier_share_of', {
                    percent,
                    value: x(totals.readEffective),
                  })}
                </span>
              )}
              {short && (
                <span>
                  {t('quota_management.multiplier_short_left', {
                    window: windowName(t, short.minutes, language),
                    value: x(short.remaining),
                    percent: percentOf(short.remaining, short.of),
                  })}
                </span>
              )}
            </p>
            {(totals.unset > 0 || totals.unread > 0) && (
              <p className={styles.tileNote}>
                {[
                  totals.unset > 0 &&
                    t('quota_management.multiplier_unset_count', { count: totals.unset }),
                  totals.unread > 0 &&
                    t('quota_management.multiplier_unread_count', { count: totals.unread }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            )}
          </article>
        );
      })}
    </div>
  );
}

/** "10× plan", "1× plan · 75% ours = 0.75×", "1× (not set)". */
function planShareText(t: TFunction, share: PlanShare, language?: string): string {
  const x = (value: number) => formatMultiplier(value, language);
  const plan = share.multiplierSet
    ? t('quota_management.multiplier_plan', { value: x(share.multiplier) })
    : t('quota_management.multiplier_plan_unset', { value: x(share.multiplier) });
  return share.capPercent < 100
    ? `${plan} · ${t('quota_management.multiplier_capped', {
        percent: share.capPercent,
        value: x(share.effective),
      })}`
    : plan;
}

export function AccountMultiplierBadge({ share }: { share: PlanShare }) {
  const { t, i18n } = useTranslation();
  return (
    <span
      className={`${styles.badge} ${share.multiplierSet ? '' : styles.badgeUnset}`}
      title={
        share.multiplierSet
          ? t('quota_management.multiplier_badge_hint')
          : t('quota_management.multiplier_unset_hint')
      }
    >
      {planShareText(t, share, i18n.resolvedLanguage)}
    </span>
  );
}

/** "0.28× of 0.75× left this week"; nothing without a reading. */
export function AccountMultiplierHeadline({ multiplier }: { multiplier: AccountMultiplier }) {
  const { t, i18n } = useTranslation();
  if (multiplier.remaining === null) return null;
  const x = (value: number) => formatMultiplier(value, i18n.resolvedLanguage);
  return (
    <p className={styles.headline}>
      <strong className={styles.headlineValue}>{x(multiplier.remaining)}</strong>
      <span className={styles.headlineCaption}>
        {t(
          multiplier.weekly
            ? 'quota_management.multiplier_account_left_week'
            : 'quota_management.multiplier_account_left_window',
          { value: x(multiplier.share.effective) }
        )}
      </span>
    </p>
  );
}
