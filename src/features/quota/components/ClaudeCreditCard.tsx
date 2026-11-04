import { useTranslation } from 'react-i18next';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useNow } from '@/hooks/useNow';
import { useNotificationStore } from '@/stores';
import { claudeCreditStatus, formatClockTime, splitMinutes } from '../claudeCreditModel';
import { useClaudeCreditFallback } from '../hooks/useClaudeCreditFallback';
import styles from './ClaudeCreditCard.module.scss';

/**
 * Global switch for paid Anthropic API credits once Claude subscriptions are
 * exhausted, as a compact label · state · toggle group in the page header (the
 * full explanation is its tooltip). Turning it on asks first and lasts the
 * gateway's fixed duration; turning it off is immediate. Renders nothing on
 * gateways without the switch.
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
  let stateText = t('usage_layout.credit_off');
  if (status.on) {
    statusText =
      status.untilMs === null
        ? t('claude_credit.status_on')
        : t('claude_credit.status_on_until', {
            time: formatClockTime(status.untilMs),
            remaining: formatDuration(status.remainingMinutes),
          });
    stateText =
      status.untilMs === null
        ? t('usage_layout.credit_on')
        : t('usage_layout.credit_on_until', {
            time: formatClockTime(status.untilMs),
            remaining: formatDuration(status.remainingMinutes),
          });
  }

  return (
    <div
      className={status.on ? `${styles.toggle} ${styles.on}` : styles.toggle}
      role="group"
      aria-labelledby="claude-credit-title"
      aria-describedby="claude-credit-status"
      title={statusText}
    >
      <span id="claude-credit-title" className={styles.title}>
        {t('claude_credit.title')}
      </span>
      <span className={styles.state} aria-hidden="true">
        {stateText}
      </span>
      <span id="claude-credit-status" className={styles.srOnly}>
        {statusText}
      </span>
      <ToggleSwitch
        checked={status.on}
        onChange={handleChange}
        disabled={saving}
        ariaLabel={t('claude_credit.toggle_label')}
      />
    </div>
  );
}
