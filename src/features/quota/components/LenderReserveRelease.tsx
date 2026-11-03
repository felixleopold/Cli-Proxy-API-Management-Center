/**
 * "Release reserve" control of a lender: lets the pool use the lender's
 * reserved share for a while (POST /usage/override {lender, duration}) and
 * ends it early (DELETE). The release covers every credential of the lender,
 * so onChange reports the new end (null once cleared) for all of them.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { useNotificationStore } from '@/stores';
import { usagePoolApi } from '@/services/api/usagePool';
import { HOUR_MS } from '@/utils/time/durations';
import { formatPoolTime } from '../usagePoolModel';
import styles from './LenderReserveRelease.module.scss';

const RELEASE_DURATIONS = [
  { duration: '1h', ms: HOUR_MS },
  { duration: '4h', ms: 4 * HOUR_MS },
  { duration: '24h', ms: 24 * HOUR_MS },
] as const;

export function LenderReserveRelease({
  lender,
  untilMs,
  onChange,
}: {
  lender: string;
  /** End of the active release, else null. */
  untilMs: number | null;
  onChange: (lender: string, untilMs: number | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const showNotification = useNotificationStore((store) => store.showNotification);
  const nowMs = useNow();
  const [saving, setSaving] = useState(false);

  const run = async (change: () => Promise<number | null>) => {
    setSaving(true);
    try {
      onChange(lender, await change());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('common.unknown_error');
      showNotification(t('lender_release.failed', { message }), 'error');
    } finally {
      setSaving(false);
    }
  };

  const release = ({ duration, ms }: (typeof RELEASE_DURATIONS)[number]) =>
    run(async () => (await usagePoolApi.setLenderOverride(lender, duration)) ?? Date.now() + ms);
  const clear = () =>
    run(async () => {
      await usagePoolApi.clearLenderOverride(lender);
      return null;
    });

  return (
    <div className={styles.release} role="group" aria-label={t('lender_release.aria', { lender })}>
      {untilMs !== null ? (
        <>
          <span className={styles.status}>
            {t('lender_release.until', {
              time: formatPoolTime(untilMs, nowMs, i18n.resolvedLanguage),
            })}
          </span>
          <button
            type="button"
            className={styles.pill}
            disabled={saving}
            onClick={() => void clear()}
          >
            {t('lender_release.clear')}
          </button>
        </>
      ) : (
        <>
          <span className={styles.label}>{t('lender_release.label')}</span>
          {RELEASE_DURATIONS.map((option) => (
            <button
              key={option.duration}
              type="button"
              className={styles.pill}
              disabled={saving}
              title={t('lender_release.hint', { lender, duration: option.duration })}
              onClick={() => void release(option)}
            >
              {option.duration}
            </button>
          ))}
        </>
      )}
    </div>
  );
}
