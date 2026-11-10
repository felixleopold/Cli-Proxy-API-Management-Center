/**
 * A row's pause button: the account takes no traffic at all until the pause
 * ends (stronger than the shield, not lifted by groups or reserve releases),
 * yet still counts toward pool capacity, unlike the Enabled toggle. Opens a
 * TimedMenu; while paused the button shows highlighted with the time left.
 * POST /usage/pause sets it, DELETE /usage/pause resumes; the row's listing
 * field follows optimistically.
 */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconPause } from '@/components/ui/icons';
import { useNow } from '@/hooks/useNow';
import { usagePoolApi } from '@/services/api/usagePool';
import { useNotificationStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import {
  activePause,
  resolveTimedChoice,
  type NextResets,
  type TimedChoice,
} from '../accountControls';
import { formatCountdown, formatWhen } from './countdown';
import { TimedMenu } from './TimedMenu';
import styles from './Accounts.module.scss';

const PAUSE_HOURS = [1, 3, 8] as const;

export function PauseControl({
  file,
  resets,
  onChange,
  onReload,
}: {
  file: AuthFileItem;
  resets: NextResets;
  onChange: (patch: Pick<AuthFileItem, 'pausedUntilMs'>) => void;
  /** Refetches the listing: pausing changes routing, and only the gateway knows the new status. */
  onReload: () => void;
}) {
  const { t, i18n } = useTranslation();
  const nowMs = useNow();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const untilMs = activePause(file, nowMs);
  const name = file.nickname || file.email || file.name;
  const left = untilMs !== null ? formatCountdown(t, untilMs, nowMs) : null;

  const run = async (change: () => Promise<Pick<AuthFileItem, 'pausedUntilMs'>>) => {
    setBusy(true);
    try {
      onChange(await change());
      onReload();
      setOpen(false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('common.unknown_error');
      showNotification(t('pause.failed', { message }), 'error');
    } finally {
      setBusy(false);
    }
  };

  const pick = (choice: TimedChoice) => {
    const resolved = resolveTimedChoice(choice, resets, Date.now());
    if (!resolved) return;
    void run(async () => {
      const end = await usagePoolApi.pauseAccount(file.name, resolved.span);
      return { pausedUntilMs: end ?? resolved.untilMs };
    });
  };
  const resume = () =>
    void run(async () => {
      await usagePoolApi.resumeAccount(file.name);
      return { pausedUntilMs: undefined };
    });

  return (
    <span className={styles.settingsAnchor} data-row-control>
      <button
        type="button"
        className={`${styles.iconButton} ${styles.paceButton}`}
        data-pace="pause"
        data-active={untilMs !== null || undefined}
        aria-label={t('pause.open', { name })}
        aria-pressed={untilMs !== null}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={
          untilMs !== null
            ? t('pause.paused_until', { time: formatWhen(untilMs, nowMs, i18n.resolvedLanguage) })
            : t('pause.title')
        }
        onClick={() => setOpen((current) => !current)}
      >
        <IconPause size={14} aria-hidden="true" />
        {left && <span className={styles.paceLeft}>{left}</span>}
      </button>
      {open && (
        <TimedMenu
          title={
            <>
              <IconPause
                size={14}
                aria-hidden="true"
                className={styles.paceMenuIcon}
                data-pace="pause"
              />
              {t('pause.title')}
            </>
          }
          description={t('pause.description')}
          hours={PAUSE_HOURS}
          resets={resets}
          active={
            untilMs !== null
              ? {
                  text: t('pace.until', {
                    time: formatWhen(untilMs, nowMs, i18n.resolvedLanguage),
                    left: left ?? '',
                  }),
                  onEnd: resume,
                  endLabel: t('pause.resume'),
                }
              : null
          }
          busy={busy}
          onPick={pick}
          onClose={close}
        />
      )}
    </span>
  );
}
