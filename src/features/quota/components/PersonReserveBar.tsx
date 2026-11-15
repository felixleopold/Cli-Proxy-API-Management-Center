/**
 * The person bar of the Usage & quota pool cards: one person's reserve, set to
 * 5%, 10% or any share up to 100%, released for a while with its end shown and
 * an Undo, and the logins it currently holds back. The reserve is judged per
 * login (PUT /config/usage-reserves/people/<name>/reserve-percent), so a login
 * below it is skipped until its window resets while the others keep serving.
 */

import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { useNow } from '@/hooks/useNow';
import type { UsagePoolReport, UsagePoolUser } from '@/services/api/usagePool';
import { useNotificationStore } from '@/stores';
import { OVERRIDE_HOURS } from '../hooks/useUsagePool';
import {
  activeOverrideUntil,
  formatPoolTime,
  heldLogins,
  parseReservePercent,
  PERSON_RESERVE_PRESETS,
} from '../usagePoolModel';
import { formatCountdown } from './countdown';
import { InfoHint } from './HoverCard';
import styles from './PersonReserveBar.module.scss';

export function PersonReserveBar({
  person,
  reports,
  saving,
  canChange,
  onSetReserve,
  onSetOverride,
}: {
  person: UsagePoolUser;
  reports: UsagePoolReport[];
  saving: boolean;
  /** The reports belong to the selected person, so a change reaches the right one. */
  canChange: boolean;
  onSetReserve: (percent: number) => Promise<void>;
  onSetOverride: (on: boolean, hours: number) => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const nowMs = useNow();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [custom, setCustom] = useState('');
  const [hours, setHours] = useState<number>(OVERRIDE_HOURS[1]);
  const releaseRef = useRef<HTMLButtonElement>(null);
  const language = i18n.resolvedLanguage;
  const reserve = person.reservePercent;
  const overrideUntil = activeOverrideUntil(person, nowMs);
  const held = heldLogins(reports);
  const customPercent = parseReservePercent(custom);
  const customInvalid = custom.trim() !== '' && customPercent === null;

  const attempt = async (change: () => Promise<void>, failedKey: string) => {
    try {
      await change();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('common.unknown_error');
      showNotification(t(failedKey, { message }), 'error');
    }
  };
  // The button is disabled while saving, which drops its focus: give it back afterwards.
  const toggleRelease = async (on: boolean) => {
    const hadFocus = document.activeElement === releaseRef.current;
    await attempt(() => onSetOverride(on, hours), 'usage_pool.override_failed');
    if (hadFocus) window.requestAnimationFrame(() => releaseRef.current?.focus());
  };
  const setReserve = (percent: number) =>
    attempt(async () => {
      await onSetReserve(percent);
      setCustom('');
    }, 'usage_pool.reserve_failed');
  const status =
    overrideUntil !== null
      ? t('usage_pool.person_override_until', {
          time: formatPoolTime(overrideUntil, nowMs, language),
        })
      : reserve <= 0
        ? t('usage_pool.person_no_reserve')
        : person.softStopped
          ? t('quota_forecast.person_paused')
          : t('usage_pool.person_using');
  const left = overrideUntil !== null ? formatCountdown(t, overrideUntil, nowMs) : null;
  const disabled = saving || !canChange;

  return (
    <div className={styles.bar}>
      <div className={styles.summary}>
        <strong>
          {reserve > 0
            ? t('usage_pool.person_reserve', { name: person.name, percent: reserve })
            : person.name}
        </strong>
        <span>
          {' · '}
          {status}
          {left && ` · ${t('usage_pool.override_left', { remaining: left })}`}
        </span>
        <InfoHint label={t('usage_pool.reserve_label')} text={t('usage_pool.reserve_hint')} />
      </div>

      <div className={styles.controls}>
        <div className={styles.group} role="group" aria-label={t('usage_pool.reserve_label')}>
          <span className={styles.label}>{t('usage_pool.reserve_label')}</span>
          <span className={styles.segmented}>
            {PERSON_RESERVE_PRESETS.map((percent) => (
              <button
                key={percent}
                type="button"
                aria-pressed={reserve === percent}
                aria-label={t('usage_pool.reserve_preset_aria', { name: person.name, percent })}
                disabled={disabled}
                onClick={() => void setReserve(percent)}
              >
                {percent}%
              </button>
            ))}
          </span>
          <form
            className={styles.custom}
            onSubmit={(event) => {
              event.preventDefault();
              if (customPercent !== null && !disabled) void setReserve(customPercent);
            }}
          >
            <span className={styles.percentInput}>
              <input
                value={custom}
                onChange={(event) => setCustom(event.target.value)}
                inputMode="decimal"
                placeholder="—"
                disabled={disabled}
                aria-label={t('usage_pool.reserve_custom_aria', { name: person.name })}
                aria-invalid={customInvalid || undefined}
                aria-describedby={customInvalid ? `${id}-invalid` : undefined}
              />
              <span aria-hidden="true">%</span>
            </span>
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              disabled={disabled || customPercent === null}
            >
              {t('usage_pool.reserve_set')}
            </Button>
          </form>
        </div>

        {reserve > 0 && (
          <div className={styles.group} role="group" aria-label={t('usage_pool.release_label')}>
            <span className={styles.label}>{t('usage_pool.release_label')}</span>
            {overrideUntil === null && (
              <Select
                size="sm"
                value={String(hours)}
                options={OVERRIDE_HOURS.map((count) => ({
                  value: String(count),
                  label: t('timed_menu.hours', { count }),
                }))}
                ariaLabel={t('usage_pool.release_length')}
                disabled={disabled}
                onChange={(value) => setHours(Number(value))}
              />
            )}
            <Button
              ref={releaseRef}
              variant="secondary"
              size="sm"
              disabled={disabled}
              aria-label={t(
                overrideUntil !== null ? 'usage_pool.release_undo_aria' : 'usage_pool.release_aria',
                { name: person.name }
              )}
              onClick={() => void toggleRelease(overrideUntil === null)}
            >
              {overrideUntil !== null
                ? t('usage_pool.release_undo')
                : t('usage_pool.release_start')}
            </Button>
          </div>
        )}
      </div>
      {customInvalid && (
        <p id={`${id}-invalid`} className={styles.error} role="alert">
          {t('usage_pool.reserve_invalid')}
        </p>
      )}

      {reserve > 0 && (
        <div className={styles.held}>
          <p className={styles.note}>{t('usage_pool.reserve_explain', { name: person.name })}</p>
          {held.length > 0 ? (
            <ul className={styles.heldList} aria-label={t('usage_pool.held_title')}>
              {held.map((login) => (
                <li key={`${login.provider}:${login.name}`}>
                  <span className={styles.heldName}>{login.label}</span>
                  {' · '}
                  {t('usage_pool.held_login', {
                    percent: Math.round(login.hold.leftPercent * 10) / 10,
                    window: t(`usage_pool.window_${login.hold.window}`),
                    reserve: login.hold.reservePercent,
                  })}
                  {login.hold.resetsAtMs !== null &&
                    ` · ${t('usage_pool.held_back_at', {
                      time: formatPoolTime(login.hold.resetsAtMs, nowMs, language),
                    })}`}
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.note}>
              {overrideUntil !== null
                ? t('usage_pool.held_released')
                : t('usage_pool.held_none', { name: person.name })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
