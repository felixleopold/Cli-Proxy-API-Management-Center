import { useTranslation } from 'react-i18next';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useNow } from '@/hooks/useNow';
import { useNotificationStore } from '@/stores';
import { claudeCreditStatus, formatClockTime, splitMinutes } from '../claudeCreditModel';
import { useClaudeCreditFallback } from '../hooks/useClaudeCreditFallback';
import styles from './ClaudeCreditCard.module.scss';

/**
 * Global switch for paid Anthropic API credits once Claude subscriptions are
 * exhausted. Turning it on asks first and lasts the gateway's fixed duration;
 * turning it off is immediate. Renders nothing on gateways without the switch.
 */
export function ClaudeCreditCard() {
  const { t } = useTranslation();
  const { state, saving, setEnabled } = useClaudeCreditFallback();
  const showConfirmation = useNotificationStore((store) => store.showConfirmation);
  const showNotification = useNotificationStore((store) => store.showNotification);
  // The countdown ticks once a minute, only while the switch is on.
  const nowMs = useNow(state?.enabled === true);

  if (!state?.configured) return null;

  const status = claudeCreditStatus(state, nowMs);
  const formatDuration = (totalMinutes: number) => {
    const { hours, minutes } = splitMinutes(totalMinutes);
    if (hours === 0) return t('claude_credit.duration_m', { minutes });
    if (minutes === 0) return t('claude_credit.duration_h', { hours });
    return t('claude_credit.duration_hm', { hours, minutes });
  };

  const apply = async (enabled: boolean) => {
    try {
      await setEnabled(enabled);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('common.unknown_error');
      showNotification(t('claude_credit.save_failed', { message }), 'error');
    }
  };

  const handleChange = (enabled: boolean) => {
    if (!enabled) {
      void apply(false);
      return;
    }
    const duration = formatDuration(state.durationSeconds / 60);
    showConfirmation({
      title: t('claude_credit.confirm_title'),
      message: t('claude_credit.confirm_message', { duration }),
      confirmText: t('claude_credit.confirm_button', { duration }),
      variant: 'primary',
      onConfirm: () => apply(true),
    });
  };

  let statusText = t('claude_credit.status_off');
  if (status.on) {
    statusText =
      status.untilMs === null
        ? t('claude_credit.status_on')
        : t('claude_credit.status_on_until', {
            time: formatClockTime(status.untilMs),
            remaining: formatDuration(status.remainingMinutes),
          });
  }

  return (
    <section
      className={status.on ? `${styles.card} ${styles.on}` : styles.card}
      aria-labelledby="claude-credit-title"
    >
      <div className={styles.copy}>
        <h2 id="claude-credit-title" className={styles.title}>
          {t('claude_credit.title')}
        </h2>
        <p className={styles.status}>{statusText}</p>
      </div>
      <ToggleSwitch
        checked={status.on}
        onChange={handleChange}
        disabled={saving}
        ariaLabel={t('claude_credit.toggle_label')}
      />
    </section>
  );
}
