/** Codex plan presentation, shared by the quota body and the account card header. */

import type { TFunction } from 'i18next';
import type { CodexQuotaState } from '@/types';
import { normalizePlanType, resolvePlanTier, PREMIUM_CODEX_PLAN_TYPES } from '@/utils/quota';
import type { QuotaClassMap } from '../../types';

// elite/premium 顺序契约由 resolvePlanTier 承载（tests/quotaPlanTier.test.ts 守护）。
export const getCodexPlanValueClass = (planType: string | null, classes: QuotaClassMap): string => {
  const tier = resolvePlanTier(planType);
  if (tier === 'elite') return classes.elitePlanValue;
  if (tier === 'premium') return classes.premiumPlanValue;
  return classes.codexPlanValue;
};

export const getCodexPlanLabel = (t: TFunction, pt?: string | null): string | null => {
  const normalized = normalizePlanType(pt);
  if (!normalized) return null;
  if (normalized === 'self_serve_business_prolite') {
    return t('codex_quota.plan_business_premium');
  }
  if (normalized === 'pro') return t('codex_quota.plan_pro');
  if (PREMIUM_CODEX_PLAN_TYPES.has(normalized) && normalized !== 'pro') {
    return t('codex_quota.plan_prolite');
  }
  if (normalized === 'plus') return t('codex_quota.plan_plus');
  if (normalized === 'team') return t('codex_quota.plan_team');
  if (normalized === 'free') return t('codex_quota.plan_free');
  return pt || normalized;
};

/** Whether the account card has renewal, credit or manual-reset details to disclose. */
export const hasCodexDetails = (quota: CodexQuotaState): boolean =>
  Boolean(quota.subscriptionActiveUntil) ||
  quota.creditsUnlimited === true ||
  (quota.creditBalance ?? null) !== null ||
  (quota.rateLimitResetCredits ?? []).length > 0;
