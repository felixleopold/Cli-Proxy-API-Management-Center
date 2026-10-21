/** Antigravity plan presentation, shared by the quota body and the account card header. */

import type { TFunction } from 'i18next';
import type { AntigravityQuotaSubscription } from '@/types';

export const getAntigravityPlanLabel = (
  subscription: AntigravityQuotaSubscription | null | undefined,
  t: TFunction
): string | null => {
  if (!subscription) return null;
  if (subscription.plan === 'free') return t('antigravity_subscription.plan_free');
  if (subscription.plan === 'pro') return t('antigravity_subscription.plan_pro');
  if (subscription.plan === 'ultra') return t('antigravity_subscription.plan_ultra');
  if (subscription.plan === 'ultra-lite') return t('antigravity_subscription.plan_ultra_lite');
  return (
    subscription.tierName ||
    subscription.tierId ||
    (subscription.plan === 'unknown' ? t('antigravity_subscription.plan_unknown') : null)
  );
};

export const isAntigravityPremiumPlan = (subscription?: AntigravityQuotaSubscription | null) => {
  const normalizedPlan = subscription?.plan?.toLowerCase() ?? '';
  return normalizedPlan === 'ultra' || normalizedPlan === 'ultra-lite';
};
