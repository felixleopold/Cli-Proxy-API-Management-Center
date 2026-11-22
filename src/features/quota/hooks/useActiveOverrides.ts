import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import type { ClaudeCreditFallback } from '@/services/api';
import type { AuthFileItem } from '@/types';
import { lenderReserves } from '../accountControls';
import { claudeCreditStatus, formatClockTime } from '../claudeCreditModel';
import { formatWhen } from '../components/countdown';

const NO_RESETS = () => ({ fiveHour: null, weekly: null });

/** Lenders whose reserve release is still running, each once, soonest end first. */
export function activeLenderReleases(
  files: readonly AuthFileItem[],
  nowMs: number
): { lender: string; untilMs: number }[] {
  return lenderReserves(files, NO_RESETS, nowMs)
    .flatMap((entry) =>
      entry.release ? [{ lender: entry.lender, untilMs: entry.release.untilMs }] : []
    )
    .sort((a, b) => a.untilMs - b.untilMs);
}

/**
 * One-line texts for the overrides currently in force (paid Claude API credits, released
 * reserves), so the phone header can show them while its controls panel is closed.
 */
export function useActiveOverrides(
  credit: ClaudeCreditFallback | null,
  files: readonly AuthFileItem[]
): { key: string; text: string }[] {
  const { t, i18n } = useTranslation();
  const nowMs = useNow();
  return useMemo(() => {
    const out: { key: string; text: string }[] = [];
    const status = credit?.configured ? claudeCreditStatus(credit, nowMs) : null;
    if (status?.on) {
      out.push({
        key: 'credit',
        text:
          status.untilMs === null
            ? t('usage_mobile.credits_on')
            : t('usage_mobile.credits_on_until', { time: formatClockTime(status.untilMs) }),
      });
    }
    for (const release of activeLenderReleases(files, nowMs)) {
      out.push({
        key: `lender:${release.lender}`,
        text: t('usage_mobile.reserve_released', {
          lender: release.lender,
          time: formatWhen(release.untilMs, nowMs, i18n.resolvedLanguage),
        }),
      });
    }
    return out;
  }, [credit, files, nowMs, t, i18n.resolvedLanguage]);
}
