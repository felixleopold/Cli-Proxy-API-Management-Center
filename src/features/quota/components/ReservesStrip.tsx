/**
 * The Reserves strip near the top of the Usage & quota page: one chip per
 * lender with what it keeps and over how many accounts, and its release. A
 * release lets the pool use the lender's reserve for a while (POST
 * /usage/override {lender, duration|until, keep_percent?}), optionally still
 * keeping a share of each window; End stops it (DELETE). It covers every
 * credential of the lender, so onChange reports the new state for all of them.
 */

import { useCallback, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useNow } from '@/hooks/useNow';
import { usagePoolApi } from '@/services/api/usagePool';
import { useNotificationStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { nextResetsOf, pooledByAuthId, windowsForFile } from '../accountCards';
import {
  lenderReserves,
  parseKeepPercentText,
  resolveTimedChoice,
  type LenderReserve,
  type TimedChoice,
} from '../accountControls';
import type { CardReading, ProviderPool } from '../quotaForecastModel';
import { formatCountdown, formatWhen } from './countdown';
import { InfoHint } from './HoverCard';
import { TimedMenu } from './TimedMenu';
import styles from './ReservesStrip.module.scss';

const RELEASE_HOURS = [1, 4, 24] as const;

export interface LenderReleaseState {
  untilMs: number | null;
  keepPercent: number | null;
}

/** "80% reserve", or "5h 10% · weekly 20%" when the windows differ. */
const reserveText = (t: TFunction, lender: LenderReserve) => {
  const { fiveHourPercent: short, weeklyPercent: long } = lender;
  if (short !== null && long !== null && short !== long) {
    return t('reserves.reserve_split', { five_hour: short, weekly: long });
  }
  return t('reserves.reserve', { percent: long ?? short ?? 0 });
};

export function ReservesStrip({
  files,
  pools,
  cardReadings,
  onChange,
  onReload,
}: {
  files: AuthFileItem[];
  pools: ProviderPool[];
  cardReadings: ReadonlyMap<string, CardReading>;
  onChange: (lender: string, release: LenderReleaseState) => void;
  /** Refetches the listing: a release changes routing, and only the gateway knows the new status. */
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const nowMs = useNow();
  const pooled = useMemo(() => pooledByAuthId(pools), [pools]);
  const lenders = lenderReserves(
    files,
    (file) => nextResetsOf(windowsForFile(file, pooled, cardReadings, nowMs)),
    nowMs
  );
  if (lenders.length === 0) return null;

  return (
    <section className={styles.strip} aria-labelledby={`${id}-title`} data-shot-section="pools">
      <span className={styles.heading}>
        <h3 id={`${id}-title`} className={styles.title}>
          {t('reserves.title')}
        </h3>
        <InfoHint label={t('reserves.title')} text={t('reserves.hint')} />
      </span>
      <ul className={styles.chips}>
        {lenders.map((lender) => (
          <LenderChip
            key={lender.lender}
            lender={lender}
            onChange={(name, release) => {
              onChange(name, release);
              onReload();
            }}
          />
        ))}
      </ul>
    </section>
  );
}

function LenderChip({
  lender,
  onChange,
}: {
  lender: LenderReserve;
  onChange: (lender: string, release: LenderReleaseState) => void;
}) {
  const { t, i18n } = useTranslation();
  const nowMs = useNow();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [keep, setKeep] = useState('');
  const keepErrorId = useId();
  const close = useCallback(() => setOpen(false), []);
  const keepPercent = parseKeepPercentText(keep);
  const keepInvalid = keepPercent === undefined;
  const { release } = lender;
  const time = (ms: number) => formatWhen(ms, nowMs, i18n.resolvedLanguage);

  const run = async (change: () => Promise<LenderReleaseState>) => {
    setBusy(true);
    try {
      onChange(lender.lender, await change());
      setOpen(false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('common.unknown_error');
      showNotification(t('lender_release.failed', { message }), 'error');
    } finally {
      setBusy(false);
    }
  };

  const pick = (choice: TimedChoice) => {
    const resolved = resolveTimedChoice(choice, lender.resets, Date.now());
    if (!resolved || keepInvalid) return;
    const kept = keepPercent ?? undefined;
    void run(async () => {
      const untilMs = await usagePoolApi.setLenderOverride(lender.lender, resolved.span, kept);
      return { untilMs: untilMs ?? resolved.untilMs, keepPercent: kept ?? null };
    });
  };
  const end = () =>
    void run(async () => {
      await usagePoolApi.clearLenderOverride(lender.lender);
      return { untilMs: null, keepPercent: null };
    });

  const accounts = t('reserves.accounts', { count: lender.accounts });
  const status = release
    ? [
        t('reserves.released_until', { time: time(release.untilMs) }),
        release.keepPercent !== null && t('reserves.keeps', { percent: release.keepPercent }),
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

  return (
    <li className={styles.chip} data-released={release ? true : undefined}>
      <span className={styles.lender}>{lender.lender}</span>
      <span
        className={styles.fact}
        title={release ? (formatCountdown(t, release.untilMs, nowMs) ?? undefined) : undefined}
      >
        {status ?? reserveText(t, lender)}
      </span>
      <span className={styles.fact}>{accounts}</span>
      <span className={styles.anchor}>
        <button
          type="button"
          className={styles.action}
          aria-expanded={open}
          aria-haspopup="dialog"
          disabled={busy}
          onClick={() => (release ? end() : setOpen((current) => !current))}
        >
          {release ? t('reserves.end') : t('reserves.release')}
        </button>
        {open && !release && (
          <TimedMenu
            title={t('reserves.release_title', { lender: lender.lender })}
            description={t('reserves.release_description', {
              lender: lender.lender,
              reserve: reserveText(t, lender),
            })}
            hours={RELEASE_HOURS}
            resets={lender.resets}
            active={null}
            busy={busy || keepInvalid}
            align="start"
            extra={
              <>
                <label className={styles.keep}>
                  <span className={styles.keepLabel}>
                    {t('reserves.keep_label')}
                    <InfoHint label={t('reserves.keep_label')} text={t('reserves.keep_hint')} />
                  </span>
                  <span className={styles.keepInput}>
                    <input
                      value={keep}
                      onChange={(event) => setKeep(event.target.value)}
                      inputMode="decimal"
                      placeholder="—"
                      aria-invalid={keepInvalid || undefined}
                      aria-describedby={keepInvalid ? keepErrorId : undefined}
                    />
                    <span aria-hidden="true">%</span>
                  </span>
                </label>
                {keepInvalid && (
                  <p id={keepErrorId} className={styles.keepError} role="alert">
                    {t('reserves.keep_invalid')}
                  </p>
                )}
              </>
            }
            onPick={pick}
            onClose={close}
          />
        )}
      </span>
    </li>
  );
}
