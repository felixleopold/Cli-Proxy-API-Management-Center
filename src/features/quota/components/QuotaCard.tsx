/**
 * Account card on the Usage & quota page: one per credential, merging its live
 * quota with the spend in its current window.
 *
 * - header: provider icon, account identity (file name on hover), plan, next reset;
 * - body, four states: idle (the whole body loads on click; upstream rate limits mean
 *   no auto-fetch), loading skeleton, error strip, success (the provider body, compact);
 * - spend row (AccountSpend), then renewal / credits / manual resets behind a disclosure
 *   whose label names the next reset expiry;
 * - footer actions.
 */

import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { IconChevronRight, IconRefreshCw } from '@/components/ui/icons';
import { useNow } from '@/hooks/useNow';
import type {
  AntigravityQuotaState,
  ClaudeQuotaState,
  CodexQuotaState,
  ResolvedTheme,
} from '@/types';
import { formatInstantShort, parseIsoToMs, resolveQuotaErrorMessage } from '@/utils/quota';
import { getQuotaDisplayName } from '@/utils/quota/identity';
import { formatRelativeInstant } from '@/utils/quota/relativeTime';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { deriveAuthFileIdentity } from '@/features/authFiles/identity';
import { AccountSpend, type AccountSpendContext } from '@/features/usage/components/AccountSpend';
import type { SubscriptionSummary } from '@/features/usage/usageModel';
import { bindQuotaClasses, type QuotaClassMap } from '../types';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';
import { isQuotaRefreshDisabled, type QuotaFileEntry } from '../logic';
import { getAntigravityPlanLabel, isAntigravityPremiumPlan } from '../providers/antigravity/plan';
import { useClaudeResetGrants } from '../providers/claude/ClaudeResetGrants';
import { ClaudeResetGrantDetails } from '../providers/claude/ClaudeResetGrantDetails';
import { CodexQuotaDetails } from '../providers/codex/CodexQuotaBody';
import {
  getCodexPlanLabel,
  getCodexPlanValueClass,
  hasCodexDetails,
} from '../providers/codex/plan';
import bodyStyles from './QuotaBody.module.scss';
import styles from './QuotaCard.module.scss';

/** 额度页全页外衣：QuotaBody 模块绑定成类型化契约（缺键在模块初始化即抛）。 */
const quotaClasses = bindQuotaClasses(bodyStyles, 'QuotaBody.module.scss');

/** The plan badge for the header, for providers whose compact body leaves it out. */
function planBadge(
  type: QuotaProviderType,
  quota: QuotaCardState,
  t: TFunction,
  classes: QuotaClassMap
): ReactNode {
  let label: string | null = null;
  let className = classes.codexPlanValue;
  if (type === 'codex') {
    const planType = (quota as CodexQuotaState).planType ?? null;
    label = getCodexPlanLabel(t, planType);
    className = getCodexPlanValueClass(planType, classes);
  } else if (type === 'claude') {
    const planType = (quota as ClaudeQuotaState).planType;
    label = planType ? t(`claude_quota.${planType}`) : null;
  } else if (type === 'antigravity') {
    const { subscription } = quota as AntigravityQuotaState;
    label = getAntigravityPlanLabel(subscription, t);
    if (isAntigravityPremiumPlan(subscription)) className = classes.premiumPlanValue;
  }
  return label ? <span className={className}>{label}</span> : null;
}

interface AccountCardHeaderProps {
  provider: string;
  resolvedTheme: ResolvedTheme;
  name: string;
  /** Lets the spend row name its account. */
  nameId: string;
  /** Renders the name in mono, when it is a file name. */
  mono?: boolean;
  /** The credential's file name, on hover. */
  title: string;
  plan?: ReactNode;
  /** End of the credential's current window. */
  resetMs: number | null;
}

function AccountCardHeader({
  provider,
  resolvedTheme,
  name,
  nameId,
  mono,
  title,
  plan,
  resetMs,
}: AccountCardHeaderProps) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const iconSrc = getAuthFileIcon(provider, resolvedTheme);
  const typeLabel = getTypeLabel(t, provider);
  return (
    <header className={styles.head}>
      <span
        className={styles.iconWrap}
        title={typeLabel}
        style={
          isThemeSurfaceIconProvider(provider)
            ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
            : undefined
        }
      >
        {iconSrc ? (
          <img src={iconSrc} alt="" className={styles.icon} />
        ) : (
          <span className={styles.iconFallback}>{typeLabel.slice(0, 1).toUpperCase()}</span>
        )}
      </span>
      <span className={styles.identity}>
        <span id={nameId} className={`${styles.name} ${mono ? styles.nameMono : ''}`} title={title}>
          {name}
        </span>
        <span className={styles.subline}>
          <span>{typeLabel}</span>
          {plan}
        </span>
      </span>
      {resetMs !== null && (
        <span
          className={styles.resetChip}
          title={new Date(resetMs).toLocaleString(i18n.resolvedLanguage, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        >
          {t('usage.sub_resets', {
            relative: formatRelativeInstant(resetMs, now, i18n.resolvedLanguage),
          })}
        </span>
      )}
    </header>
  );
}

/**
 * Account details behind a native disclosure: keyboard operable and announced as expandable.
 * Labelled with the manual reset count when there is at least one, else "Details", plus the
 * soonest of `expiries` still ahead, so the next expiry reads without expanding.
 */
function AccountDetails({
  count,
  expiries,
  children,
}: {
  count: number | null;
  expiries: readonly unknown[];
  children: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const nextMs = expiries.reduce<number | null>((next, expiry) => {
    const ms = parseIsoToMs(expiry);
    return ms !== null && ms > now && (next === null || ms < next) ? ms : next;
  }, null);
  return (
    <details className={styles.details}>
      <summary className={styles.detailsSummary}>
        {count === null || count <= 0
          ? t('quota_management.details_more')
          : t('quota_management.details_resets', { count })}
        {nextMs !== null && (
          <span className={styles.detailsNext} title={formatInstantShort(nextMs)}>
            {'· '}
            {t('quota_management.details_next_expiry', {
              relative: formatRelativeInstant(nextMs, now, i18n.resolvedLanguage),
            })}
          </span>
        )}
        <IconChevronRight size={13} aria-hidden="true" className={styles.detailsChevron} />
      </summary>
      <div className={styles.detailsBody}>{children}</div>
    </details>
  );
}

/** Spend for a credential without quota support. */
export function SpendOnlyCard({
  summary,
  spend,
  resolvedTheme,
}: {
  summary: SubscriptionSummary;
  spend: AccountSpendContext;
  resolvedTheme: ResolvedTheme;
}) {
  const { subscription } = summary;
  const nameId = useId();
  return (
    <article className={styles.card} data-active={spend.activeId === subscription.id || undefined}>
      <AccountCardHeader
        provider={subscription.provider}
        resolvedTheme={resolvedTheme}
        name={subscription.name || subscription.id}
        nameId={nameId}
        title={subscription.id}
        resetMs={summary.window?.endMs ?? null}
      />
      <AccountSpend summary={summary} context={spend} labelId={nameId} />
    </article>
  );
}

export type QuotaCardProps = {
  entry: QuotaFileEntry;
  quota?: QuotaCardState;
  resolvedTheme: ResolvedTheme;
  canRefresh: boolean;
  resetting: boolean;
  /** 首屏级联入场延迟；null = 不入场（切 tab / 翻页 / 刷新新挂载的卡片）。 */
  entranceDelayMs?: number | null;
  /** Spend in this credential's current window; null without ledger data for it. */
  summary: SubscriptionSummary | null;
  spend: AccountSpendContext;
  onRefresh: () => void;
  onReset: () => void;
};

export function QuotaCard(props: QuotaCardProps) {
  const {
    entry,
    quota,
    resolvedTheme,
    canRefresh,
    resetting,
    entranceDelayMs,
    summary,
    spend,
    onRefresh,
    onReset,
  } = props;
  const { t } = useTranslation();
  const adapter = QUOTA_ADAPTERS[entry.type];
  const file = entry.file;
  const identity = deriveAuthFileIdentity(file);
  const nameId = useId();

  // 挂载时捕获一次延迟：后续 props 变 null 不影响本卡（React 19 禁渲染期读 ref）
  const [mountEntranceDelayMs] = useState<number | null>(entranceDelayMs ?? null);
  const entranceStyle =
    mountEntranceDelayMs === null
      ? undefined
      : ({ '--card-delay': `${mountEntranceDelayMs}ms` } as CSSProperties);

  const status = quota?.status ?? 'idle';
  const loading = status === 'loading';
  const claudeReset = useClaudeResetGrants(
    file,
    entry.type === 'claude' && status !== 'idle',
    !canRefresh || loading || resetting,
    quota,
    onRefresh
  );
  const errorMessage = resolveQuotaErrorMessage(
    t,
    quota?.errorStatus,
    quota?.error || t('common.unknown_error')
  );
  const showReset =
    status === 'success' &&
    Boolean(adapter.resetQuota) &&
    quota !== undefined &&
    Boolean(adapter.canResetQuota?.(quota));
  const loaded = status === 'success' && quota !== undefined;
  const codexQuota = loaded && entry.type === 'codex' ? (quota as CodexQuotaState) : null;
  const claudeGrants = loaded ? claudeReset.grants.filter((grant) => grant.resetsLeft > 0) : [];

  return (
    <article
      className={`${styles.card} ${mountEntranceDelayMs === null ? '' : styles.cardEnter}`}
      style={entranceStyle}
      data-active={(summary !== null && spend.activeId === summary.subscription.id) || undefined}
    >
      <AccountCardHeader
        provider={entry.type}
        resolvedTheme={resolvedTheme}
        name={identity.primary || getQuotaDisplayName(file)}
        mono={identity.kind === 'fileName'}
        nameId={nameId}
        title={getQuotaDisplayName(file)}
        plan={loaded ? planBadge(entry.type, quota, t, quotaClasses) : null}
        resetMs={summary?.window?.endMs ?? null}
      />

      <div className={styles.body}>
        {entry.type === 'claude' && loaded && claudeGrants.length === 0 && (
          // Without grants to disclose, the count stays visible as on the base card.
          <div className={quotaClasses.codexPlan}>
            <span className={quotaClasses.codexPlanItem}>
              <span className={quotaClasses.codexPlanLabel}>{t('claude_reset.remaining')}</span>
              <span className={quotaClasses.codexPlanValue}>{claudeReset.count ?? '--'}</span>
            </span>
          </div>
        )}
        {codexQuota &&
          !hasCodexDetails(codexQuota) &&
          (codexQuota.rateLimitResetCreditsAvailableCount ?? null) !== null && (
            // Nothing to disclose: the known count stays visible as on the base card.
            <div className={quotaClasses.codexPlan}>
              <span className={quotaClasses.codexPlanItem}>
                <span className={quotaClasses.codexPlanLabel}>
                  {t('codex_quota.reset_credits_label')}
                </span>
                <span className={quotaClasses.codexPlanValue}>
                  {codexQuota.rateLimitResetCreditsAvailableCount}
                </span>
              </span>
            </div>
          )}
        {entry.type === 'claude' && loaded && claudeReset.message && (
          <div role="status" className={quotaClasses.codexResetCreditsError}>
            {t(`claude_reset.${claudeReset.message}`)}
          </div>
        )}
        {status === 'idle' ? (
          <button
            type="button"
            className={styles.idleBody}
            onClick={onRefresh}
            disabled={!canRefresh}
          >
            <IconRefreshCw size={15} aria-hidden="true" className={styles.idleGlyph} />
            <span className={styles.idleHint}>{t(`${adapter.i18nPrefix}.idle`)}</span>
          </button>
        ) : loading ? (
          <div className={styles.skeleton} aria-busy="true">
            <span className={styles.srOnly}>{t(`${adapter.i18nPrefix}.loading`)}</span>
            {[0, 1].map((row) => (
              <div key={row} className={styles.skeletonRow} aria-hidden="true">
                <span className={styles.skeletonLabel} />
                <span className={styles.skeletonTrack} />
              </div>
            ))}
          </div>
        ) : status === 'error' ? (
          <div className={styles.errorStrip} role="alert">
            {t(`${adapter.i18nPrefix}.load_failed`, { message: errorMessage })}
          </div>
        ) : quota ? (
          <adapter.Body quota={quota} classes={quotaClasses} compact />
        ) : (
          <div className={styles.idleHint}>{t(`${adapter.i18nPrefix}.idle`)}</div>
        )}
      </div>

      <AccountSpend summary={summary} context={spend} labelId={nameId} />

      {codexQuota && hasCodexDetails(codexQuota) && (
        <AccountDetails
          count={codexQuota.rateLimitResetCreditsAvailableCount ?? null}
          expiries={(codexQuota.rateLimitResetCredits ?? [])
            .filter((credit) => credit.status === 'available')
            .map((credit) => credit.expiresAt)}
        >
          <CodexQuotaDetails quota={codexQuota} classes={quotaClasses} />
        </AccountDetails>
      )}
      {claudeGrants.length > 0 && (
        <AccountDetails
          count={claudeReset.count}
          expiries={claudeGrants.map((grant) => grant.endsAt)}
        >
          <ClaudeResetGrantDetails grants={claudeGrants} classes={quotaClasses} />
        </AccountDetails>
      )}

      {status !== 'idle' && (
        <footer className={styles.actionRow}>
          {entry.type === 'claude' && (
            <button
              type="button"
              className={styles.actionPill}
              disabled={claudeReset.blocked}
              onClick={claudeReset.confirm}
              title={t(`claude_reset.${claudeReset.buttonLabel}`)}
            >
              <IconRefreshCw size={13} className={claudeReset.busy ? styles.spinning : undefined} />
              {t(`claude_reset.${claudeReset.buttonLabel}`)}
            </button>
          )}
          {showReset && (
            <button
              type="button"
              className={styles.actionPill}
              onClick={onReset}
              disabled={!canRefresh || loading || resetting}
              title={t('codex_quota.reset_button')}
            >
              <IconRefreshCw size={13} className={resetting ? styles.spinning : undefined} />
              {t('codex_quota.reset_button')}
            </button>
          )}
          <button
            type="button"
            className={styles.actionPill}
            onClick={onRefresh}
            disabled={isQuotaRefreshDisabled(canRefresh, loading, resetting || claudeReset.busy)}
            title={t('auth_files.quota_refresh_hint')}
          >
            <IconRefreshCw size={13} className={loading ? styles.spinning : undefined} />
            {t('auth_files.quota_refresh_single')}
          </button>
        </footer>
      )}
    </article>
  );
}
