import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { useNow } from '@/hooks/useNow';
import type { AnthropicResetGrant } from '@/services/api/claudeResetGrants';
import { buildResetDisplay, parseIsoToMs } from '@/utils/quota';
import { resolveTimeZoneLabel } from '@/utils/time/timezone';
import { QuotaResetLabel } from '../../components/QuotaResetLabel';
import type { QuotaClassMap } from '../../types';
import { useResetGrantText } from './useResetGrantText';

interface ClaudeResetGrantDetailsProps {
  grants: readonly AnthropicResetGrant[];
  classes: QuotaClassMap;
  /** Why a grant cannot be redeemed now, or null when it can. */
  blocker: (grant: AnthropicResetGrant) => string | null;
  /** Panel-wide lock (busy, refreshing, disconnected, expired retry). */
  locked: boolean;
  pendingGrantId: string | null;
  onRedeem: (grantId: string) => void;
}

/** One row per grant with resets left: kind, balance, expiry, give-back, and redeem or why not. */
export function ClaudeResetGrantDetails({
  grants,
  classes,
  blocker,
  locked,
  pendingGrantId,
  onRedeem,
}: ClaudeResetGrantDetailsProps) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const text = useResetGrantText(now);
  const remaining = grants
    .filter((grant) => grant.resetsLeft > 0)
    .sort((a, b) => (parseIsoToMs(a.endsAt) ?? Infinity) - (parseIsoToMs(b.endsAt) ?? Infinity));

  if (remaining.length === 0) return null;

  return (
    <div className={classes.codexResetCredits}>
      <div className={classes.codexResetCreditsTitle}>
        {t('claude_reset.expiry_title', { timezone: resolveTimeZoneLabel() })}
      </div>
      {remaining.map((grant) => {
        const display = buildResetDisplay(
          null,
          parseIsoToMs(grant.endsAt),
          now,
          i18n.resolvedLanguage
        );
        const reason = blocker(grant);
        const retry = pendingGrantId === grant.id;
        return (
          <div key={grant.id} className={classes.codexResetCreditRow}>
            <span className={classes.codexResetCreditLabel}>
              {text.kind(grant)}
              {grant.label && ` (${grant.label})`}
              {' · '}
              {t('claude_reset.count', { left: grant.resetsLeft, total: grant.resetsTotal })}
              <br />
              {text.givesBack(grant)}
              {reason && (
                <>
                  <br />
                  {reason}
                </>
              )}
            </span>
            <span className={classes.codexResetCreditTime}>
              {display ? (
                <QuotaResetLabel display={display} classes={classes} />
              ) : (
                <span className={classes.quotaReset}>{t('claude_reset.expiry_unknown')}</span>
              )}
              {!reason && (
                <>
                  <br />
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={locked}
                    onClick={() => onRedeem(grant.id)}
                  >
                    {t(retry ? 'claude_reset.retry_short' : 'claude_reset.redeem')}
                  </Button>
                </>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
