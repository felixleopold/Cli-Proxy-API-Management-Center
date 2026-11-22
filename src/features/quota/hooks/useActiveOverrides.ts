import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import type { ClaudeCreditFallback } from '@/services/api';
import type { AuthFileItem } from '@/types';
import { claudeCreditStatus, formatClockTime } from '../claudeCreditModel';
import { formatWhen } from '../components/countdown';

/** Lenders whose reserve release is still running, each once, soonest end first. */
export function activeLenderReleases(
  files: readonly AuthFileItem[],
  nowMs: number
): { lender: string; untilMs: number }[] {
  const byLender = new Map<string, number>();
  for (const file of files) {
    const untilMs = file.lenderReserveOverrideUntilMs;
    if (!file.lender || untilMs === undefined || untilMs <= nowMs) continue;
    byLender.set(file.lender, Math.max(byLender.get(file.lender) ?? 0, untilMs));
  }
  return [...byLender]
    .map(([lender, untilMs]) => ({ lender, untilMs }))
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
