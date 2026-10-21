/**
 * Codex 额度渲染体：套餐 chip 行（elite=Pro 20x 液态铂金 / premium=金卡）、
 * 重置积分明细、用量窗口水位条。
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodexQuotaState } from '@/types';
import { buildResetDisplay, formatInstantShort, parseIsoToMs, resolveResetMs } from '@/utils/quota';
import { resolveTimeZoneLabel } from '@/utils/time/timezone';
import { formatDateTimeValue } from '@/utils/format';
import { useNow } from '@/hooks/useNow';
import { QuotaMeter } from '../../components/QuotaMeter';
import { QuotaResetLabel } from '../../components/QuotaResetLabel';
import { collectQuotaRowInstants, pickUrgentRowId, resetCreditRowId } from '../../resetSchedule';
import type { QuotaBodyProps, QuotaClassMap } from '../../types';
import { getCodexPlanLabel, getCodexPlanValueClass } from './plan';

// Windows and reset credits compete for the same emphasis, but only during
// the final hour before the reset or expiry.
const useSoonestRowId = (quota: CodexQuotaState, now: number) =>
  useMemo(() => pickUrgentRowId(collectQuotaRowInstants('codex', quota), now), [quota, now]);

interface CodexPlanRowProps {
  quota: CodexQuotaState;
  classes: QuotaClassMap;
  /** The compact details row leaves plan and reset count to the card header and disclosure. */
  withPlanAndCount: boolean;
}

function CodexPlanRow({ quota, classes, withPlanAndCount }: CodexPlanRowProps) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const planType = quota.planType ?? null;
  const subscriptionActiveUntil = quota.subscriptionActiveUntil ?? null;
  const creditBalance = quota.creditBalance ?? null;
  const creditsUnlimited = quota.creditsUnlimited === true;
  const resetCount = withPlanAndCount ? (quota.rateLimitResetCreditsAvailableCount ?? null) : null;
  const planLabel = withPlanAndCount ? getCodexPlanLabel(t, planType) : null;

  // Renewal was the one date on this card in a different shape (a full
  // toLocaleString). Reformatted from the instant so it reads like the rest,
  // falling back to the old rendering when the payload isn't parseable.
  const subscriptionMs = resolveResetMs([subscriptionActiveUntil]);
  const expiryDisplay = subscriptionActiveUntil
    ? buildResetDisplay(
        subscriptionMs === null ? formatDateTimeValue(subscriptionActiveUntil) : null,
        subscriptionMs,
        now,
        i18n.resolvedLanguage
      )
    : null;

  if (
    !planLabel &&
    !expiryDisplay &&
    !creditsUnlimited &&
    creditBalance === null &&
    resetCount === null
  ) {
    return null;
  }
  return (
    <div className={classes.codexPlan}>
      {planLabel && (
        <span className={classes.codexPlanItem}>
          <span className={classes.codexPlanLabel}>{t('codex_quota.plan_label')}</span>
          <span className={getCodexPlanValueClass(planType, classes)}>{planLabel}</span>
        </span>
      )}
      {expiryDisplay && (
        <span className={classes.codexPlanItem}>
          <span className={classes.codexPlanLabel}>{t('codex_quota.expires_label')}</span>
          <span className={classes.codexPlanValue}>{expiryDisplay.absolute}</span>
          {expiryDisplay.relative && (
            <span className={classes.quotaResetRelative}>{expiryDisplay.relative}</span>
          )}
        </span>
      )}
      {(creditsUnlimited || creditBalance !== null) && (
        <span className={classes.codexPlanItem}>
          <span className={classes.codexPlanLabel}>{t('codex_quota.credit_balance_label')}</span>
          <span className={classes.codexPlanValue}>
            {creditsUnlimited ? t('codex_quota.credit_unlimited') : creditBalance}
          </span>
        </span>
      )}
      {resetCount !== null && (
        <span className={classes.codexPlanItem}>
          <span className={classes.codexPlanLabel}>{t('codex_quota.reset_credits_label')}</span>
          <span className={classes.codexPlanValue}>{resetCount.toString()}</span>
        </span>
      )}
    </div>
  );
}

function CodexResetCreditList({
  quota,
  classes,
  soonestRowId,
}: {
  quota: CodexQuotaState;
  classes: QuotaClassMap;
  soonestRowId: string | null;
}) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  return (
    <div className={classes.codexResetCredits}>
      <div className={classes.codexResetCreditsTitle}>
        {t('codex_quota.reset_credits_expiry_label', { timezone: resolveTimeZoneLabel() })}
      </div>
      {(quota.rateLimitResetCredits ?? []).map((credit, index) => {
        const expiresAtMs = parseIsoToMs(credit.expiresAt);
        const expiresDisplay = buildResetDisplay(
          expiresAtMs === null ? credit.expiresAt : formatInstantShort(expiresAtMs),
          expiresAtMs,
          now,
          i18n.resolvedLanguage
        );
        // One expression for both the key and the highlight — two copies
        // that drift would emphasize the wrong row.
        const rowId = resetCreditRowId(credit, index);
        const soon = rowId === soonestRowId;
        return (
          <div
            key={rowId}
            className={
              soon
                ? `${classes.codexResetCreditRow} ${classes.codexResetCreditRowSoon}`
                : classes.codexResetCreditRow
            }
            title={soon ? t('quota_management.soonest_row_hint') : undefined}
          >
            <span className={classes.codexResetCreditLabel}>
              {t('codex_quota.reset_credit_number', { index: index + 1 })}
            </span>
            <span className={classes.codexResetCreditTime}>
              {expiresDisplay && (
                <QuotaResetLabel display={expiresDisplay} classes={classes} soon={soon} />
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Renewal, credit balance and manual reset expiries, for the account card's disclosure. */
export function CodexQuotaDetails({ quota, classes }: QuotaBodyProps<CodexQuotaState>) {
  const soonestRowId = useSoonestRowId(quota, useNow());
  return (
    <>
      <CodexPlanRow quota={quota} classes={classes} withPlanAndCount={false} />
      {(quota.rateLimitResetCredits ?? []).length > 0 && (
        <CodexResetCreditList quota={quota} classes={classes} soonestRowId={soonestRowId} />
      )}
    </>
  );
}

export function CodexQuotaBody({ quota, classes, compact }: QuotaBodyProps<CodexQuotaState>) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const locale = i18n.resolvedLanguage;
  const soonestRowId = useSoonestRowId(quota, now);
  const windows = quota.windows ?? [];
  const rateLimitResetCredits = quota.rateLimitResetCredits ?? [];
  const rateLimitResetCreditsError = quota.rateLimitResetCreditsError ?? '';

  return (
    <>
      {!compact && <CodexPlanRow quota={quota} classes={classes} withPlanAndCount />}
      {rateLimitResetCredits.length > 0 ? (
        !compact && (
          <CodexResetCreditList quota={quota} classes={classes} soonestRowId={soonestRowId} />
        )
      ) : rateLimitResetCreditsError ? (
        <div className={classes.codexResetCreditsError}>
          {t('codex_quota.reset_credits_expiry_failed', {
            message: rateLimitResetCreditsError,
          })}
        </div>
      ) : null}
      {windows.length === 0 ? (
        <div className={classes.quotaMessage}>{t('codex_quota.empty_windows')}</div>
      ) : (
        windows.map((window, index) => {
          const used = window.usedPercent;
          const clampedUsed = used === null ? null : Math.max(0, Math.min(100, used));
          const remaining =
            clampedUsed === null ? null : Math.max(0, Math.min(100, 100 - clampedUsed));
          const percentLabel =
            remaining === null
              ? '--'
              : t('quota_management.percent_left', { percent: Math.round(remaining) });
          const windowLabel = window.labelKey
            ? t(window.labelKey, window.labelParams as Record<string, string | number>)
            : window.label;
          const resetDisplay = buildResetDisplay(window.resetLabel, window.resetAtMs, now, locale);

          const soon = window.id === soonestRowId;

          return (
            <div
              key={window.id}
              className={classes.quotaRow}
              title={soon ? t('quota_management.soonest_row_hint') : undefined}
            >
              <div className={classes.quotaRowHeader}>
                <span className={classes.quotaModel}>{windowLabel}</span>
                <div className={classes.quotaMeta}>
                  <span className={classes.quotaPercent}>{percentLabel}</span>
                  {resetDisplay && (
                    <QuotaResetLabel display={resetDisplay} classes={classes} soon={soon} />
                  )}
                </div>
              </div>
              <QuotaMeter percent={remaining} classes={classes} index={index} />
            </div>
          );
        })
      )}
    </>
  );
}
