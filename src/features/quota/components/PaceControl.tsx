/**
 * A row's pace buttons: ⚡ flash (route here first) and the shield (protect:
 * use only when nothing else is eligible). Each opens a TimedMenu; the active
 * mode shows highlighted with its time left. POST /usage/pace sets it,
 * DELETE /usage/pace ends it; the row's listing fields follow optimistically.
 */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconShield, IconZap } from '@/components/ui/icons';
import { useNow } from '@/hooks/useNow';
import { usagePoolApi } from '@/services/api/usagePool';
import { useNotificationStore } from '@/stores';
import type { AuthFileItem, AuthFilePaceMode } from '@/types';
import {
  activePace,
  resolveTimedChoice,
  type NextResets,
  type TimedChoice,
} from '../accountControls';
import { formatCountdown, formatWhen } from './countdown';
import { TimedMenu } from './TimedMenu';
import styles from './Accounts.module.scss';

const PACE_HOURS = [1, 4] as const;
const PACE_ICON = { flash: IconZap, shield: IconShield } as const;

export function PaceControl({
  file,
  resets,
  onChange,
}: {
  file: AuthFileItem;
  resets: NextResets;
  onChange: (patch: Pick<AuthFileItem, 'paceMode' | 'paceUntilMs'>) => void;
}) {
  const { t, i18n } = useTranslation();
  const nowMs = useNow();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [open, setOpen] = useState<AuthFilePaceMode | null>(null);
  const [busy, setBusy] = useState(false);
  const close = useCallback(() => setOpen(null), []);
  const active = activePace(file, nowMs);
  const name = file.nickname || file.email || file.name;

  const run = async (change: () => Promise<Pick<AuthFileItem, 'paceMode' | 'paceUntilMs'>>) => {
    setBusy(true);
    try {
      onChange(await change());
      setOpen(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('common.unknown_error');
      showNotification(t('pace.failed', { message }), 'error');
    } finally {
      setBusy(false);
    }
  };

  const pick = (mode: AuthFilePaceMode, choice: TimedChoice) => {
    const resolved = resolveTimedChoice(choice, resets, Date.now());
    if (!resolved) return;
    void run(async () => {
      const untilMs = await usagePoolApi.setPace(file.name, mode, resolved.span);
      return { paceMode: mode, paceUntilMs: untilMs ?? resolved.untilMs };
    });
  };
  const end = () =>
    void run(async () => {
      await usagePoolApi.clearPace(file.name);
      return { paceMode: undefined, paceUntilMs: undefined };
    });

  return (
    <span className={styles.pace} data-row-control>
      {(['flash', 'shield'] as const).map((mode) => {
        const Icon = PACE_ICON[mode];
        const on = active?.mode === mode;
        const left = on ? formatCountdown(t, active.untilMs, nowMs) : null;
        return (
          <span key={mode} className={styles.settingsAnchor}>
            <button
              type="button"
              className={`${styles.iconButton} ${styles.paceButton}`}
              data-pace={mode}
              data-active={on || undefined}
              aria-label={t(`pace.${mode}_open`, { name })}
              aria-pressed={on}
              aria-expanded={open === mode}
              aria-haspopup="dialog"
              title={
                on
                  ? t('pace.active_until', {
                      mode: t(`pace.${mode}_title`),
                      time: formatWhen(active.untilMs, nowMs, i18n.resolvedLanguage),
                    })
                  : t(`pace.${mode}_title`)
              }
              onClick={() => setOpen((current) => (current === mode ? null : mode))}
            >
              <Icon size={14} aria-hidden="true" />
              {left && <span className={styles.paceLeft}>{left}</span>}
            </button>
            {open === mode && (
              <TimedMenu
                title={
                  <>
                    <Icon
                      size={14}
                      aria-hidden="true"
                      className={styles.paceMenuIcon}
                      data-pace={mode}
                    />
                    {t(`pace.${mode}_title`)}
                  </>
                }
                description={t(`pace.${mode}_description`)}
                hours={PACE_HOURS}
                resets={resets}
                active={
                  on
                    ? {
                        text: t('pace.until', {
                          time: formatWhen(active.untilMs, nowMs, i18n.resolvedLanguage),
                          left: formatCountdown(t, active.untilMs, nowMs) ?? '',
                        }),
                        onEnd: end,
                      }
                    : null
                }
                busy={busy}
                onPick={(choice) => pick(mode, choice)}
                onClose={close}
              />
            )}
          </span>
        );
      })}
    </span>
  );
}
