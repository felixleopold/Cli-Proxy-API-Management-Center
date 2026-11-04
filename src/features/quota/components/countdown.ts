import type { TFunction } from 'i18next';
import { countdownParts, formatResetInstant } from '@/utils/quota/relativeTime';

/** "1d 3h", "2h 10m", "5m"; null once the instant has passed. */
export function formatCountdown(t: TFunction, untilMs: number, nowMs: number): string | null {
  const parts = countdownParts(untilMs, nowMs);
  if (!parts) return null;
  return parts.days > 0
    ? t('usage_accounts.countdown_days', { days: parts.days, hours: parts.hours })
    : parts.hours > 0
      ? t('usage_accounts.countdown_hours', { hours: parts.hours, minutes: parts.minutes })
      : t('usage_accounts.countdown_minutes', { minutes: parts.minutes });
}

/** "18:00" today, "Fri 16:00" within the week, else "Nov 12, 16:00" (24-hour, as the rows read). */
export function formatWhen(ms: number, nowMs: number, locale?: string): string {
  if (new Date(ms).toDateString() !== new Date(nowMs).toDateString()) {
    return formatResetInstant(ms, nowMs, locale);
  }
  const options: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  };
  try {
    return new Date(ms).toLocaleTimeString(locale, options);
  } catch {
    return new Date(ms).toLocaleTimeString(undefined, options);
  }
}
