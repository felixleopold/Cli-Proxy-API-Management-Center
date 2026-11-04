/**
 * The small menu behind a timed control (a row's ⚡ / shield pace, a lender's
 * reserve release): what it does, when it ends now with an End button, and the
 * choices — until the next 5-hour or weekly reset, a fixed number of hours, or
 * a custom date and time. Resets resolve to an instant in accountControls.ts.
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { HOUR_MS } from '@/utils/time/durations';
import { resolveTimedChoice, type NextResets, type TimedChoice } from '../accountControls';
import { formatWhen } from './countdown';
import styles from './TimedMenu.module.scss';

/** The preset durations of a menu, in hours. */
export type TimedMenuHours = readonly number[];

/** Closes on Escape (focus back to the trigger) and on a pointer press outside the anchor. */
function usePopoverDismiss<T extends HTMLElement>(onClose: () => void) {
  const rootRef = useRef<T>(null);
  const closeToTrigger = useCallback(() => {
    const trigger = rootRef.current?.parentElement?.querySelector('button');
    onClose();
    trigger?.focus();
  }, [onClose]);
  useEffect(() => {
    const root = rootRef.current;
    const handlePointerDown = (event: MouseEvent) => {
      if (!root?.parentElement?.contains(event.target as Node)) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeToTrigger();
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, closeToTrigger]);
  return { rootRef, closeToTrigger };
}

/** "2026-11-04T17:00" in local time, for a datetime-local input. */
const localInputValue = (ms: number) => {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
};

export interface TimedMenuProps {
  title: ReactNode;
  description: string;
  hours: TimedMenuHours;
  resets: NextResets;
  /** The running override: "Until 18:20 · 2h 59m" and its End button. */
  active: { text: string; onEnd: () => void } | null;
  /** Extra fields above the choices, e.g. the share a release keeps. */
  extra?: ReactNode;
  busy: boolean;
  /** Pressing a choice starts (or replaces) the override. */
  onPick: (choice: TimedChoice) => void;
  onClose: () => void;
  align?: 'start' | 'end';
}

export function TimedMenu({
  title,
  description,
  hours,
  resets,
  active,
  extra,
  busy,
  onPick,
  onClose,
  align = 'end',
}: TimedMenuProps) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const nowMs = useNow();
  const { rootRef } = usePopoverDismiss<HTMLDivElement>(onClose);
  const [custom, setCustom] = useState(() =>
    localInputValue(Math.ceil((nowMs + 2 * HOUR_MS) / HOUR_MS) * HOUR_MS)
  );
  const customMs = Date.parse(custom);
  const customValid = resolveTimedChoice({ kind: 'at', atMs: customMs }, resets, nowMs) !== null;

  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>('input, button:not(:disabled)')?.focus();
  }, [rootRef]);

  const resetChoice = (kind: 'five_hour' | 'weekly') => {
    const atMs = kind === 'five_hour' ? resets.fiveHour : resets.weekly;
    const known = atMs !== null && atMs > nowMs;
    return (
      <button
        key={kind}
        type="button"
        className={styles.choice}
        disabled={busy || !known}
        onClick={() => onPick({ kind })}
      >
        <span>{t(`timed_menu.until_${kind}`)}</span>
        <span className={styles.when}>
          {known ? formatWhen(atMs, nowMs, i18n.resolvedLanguage) : t('timed_menu.reset_unknown')}
        </span>
      </button>
    );
  };

  return (
    <div
      ref={rootRef}
      className={styles.menu}
      data-align={align}
      role="dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      data-row-control
    >
      <div id={`${id}-title`} className={styles.title}>
        {title}
      </div>
      <p id={`${id}-description`} className={styles.description}>
        {description}
      </p>

      {active && (
        <div className={styles.active}>
          <span>{active.text}</span>
          <button type="button" className={styles.end} disabled={busy} onClick={active.onEnd}>
            {t('timed_menu.end')}
          </button>
        </div>
      )}

      {extra}

      <div className={styles.choices} role="group" aria-label={t('timed_menu.how_long')}>
        {resetChoice('five_hour')}
        {resetChoice('weekly')}
        <div className={styles.hours}>
          {hours.map((count) => (
            <button
              key={count}
              type="button"
              className={styles.hour}
              disabled={busy}
              onClick={() => onPick({ kind: 'hours', hours: count })}
            >
              {t('timed_menu.hours', { count })}
            </button>
          ))}
        </div>
        <form
          className={styles.custom}
          onSubmit={(event) => {
            event.preventDefault();
            if (customValid) onPick({ kind: 'at', atMs: customMs });
          }}
        >
          <input
            type="datetime-local"
            className={styles.input}
            value={custom}
            min={localInputValue(nowMs)}
            onChange={(event) => setCustom(event.target.value)}
            aria-label={t('timed_menu.custom_label')}
          />
          <button type="submit" className={styles.hour} disabled={busy || !customValid}>
            {t('timed_menu.custom_set')}
          </button>
        </form>
      </div>
    </div>
  );
}
