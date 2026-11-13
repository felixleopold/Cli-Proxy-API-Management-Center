/**
 * Account rows for credentials with quota support (QuotaAccountRow) and for
 * spend the ledger has on credentials without it (SpendAccountRow). The quota
 * row loads on its refresh button (upstream rate limits mean no auto-fetch) and
 * reads its bars before that from the gateway's live signals; its details hold
 * the account (email, file, plan, lender, routing) and the spend split beside
 * every window (model-scoped ones too), manual resets, renewal and credits and
 * errors. Lender reserve releases live in the Reserves strip at the top.
 */

import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { IconRefreshCw, IconTimer } from '@/components/ui/icons';
import { useNow } from '@/hooks/useNow';
import type {
  AntigravityQuotaState,
  AuthFileItem,
  ClaudeQuotaState,
  CodexQuotaState,
  ResolvedTheme,
} from '@/types';
import { resolveQuotaErrorMessage } from '@/utils/quota';
import { resolveAuthProvider } from '@/utils/quota/validators';
import { getQuotaDisplayName } from '@/utils/quota/identity';
import { supportsAuthFileUsageCap } from '@/features/authFiles/constants';
import { deriveAuthFileIdentity } from '@/features/authFiles/identity';
import type { AccountSpendContext } from '@/features/usage/components/AccountSpend';
import { slotClassName } from '@/features/usage/components/slotClass';
import { formatUsd, type SubscriptionSummary } from '@/features/usage/usageModel';
import type { AccountWindows } from '../accountCards';
import { isQuotaRefreshDisabled, resolveQuotaProviderType, type QuotaFileEntry } from '../logic';
import { formatMultiplier, planShareOf, planShareText } from '../planMultipliers';
import { isRenewalSoon, resolveRenewal, type Renewal } from '../renewal';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';
import { getAntigravityPlanLabel } from '../providers/antigravity/plan';
import { useClaudeResetGrants } from '../providers/claude/ClaudeResetGrants';
import { ClaudeResetGrantDetails } from '../providers/claude/ClaudeResetGrantDetails';
import { CodexQuotaDetails } from '../providers/codex/CodexQuotaBody';
import { getCodexPlanLabel, hasCodexDetails } from '../providers/codex/plan';
import { bindQuotaClasses } from '../types';
import { AccountRow, DetailFact, RowIconButton } from './AccountRow';
import { HoverCard } from './HoverCard';
import bodyStyles from './QuotaBody.module.scss';
import styles from './Accounts.module.scss';
import renewalStyles from './Renewal.module.scss';

const quotaClasses = bindQuotaClasses(bodyStyles, 'QuotaBody.module.scss');

/** The plan as plain text: a loaded card names it, else the plan set on a Claude credential. */
function planLabel(
  type: QuotaProviderType,
  quota: QuotaCardState | undefined,
  file: AuthFileItem,
  t: TFunction
): string | null {
  const loaded = quota?.status === 'success' ? quota : null;
  if (type === 'codex' && loaded) return getCodexPlanLabel(t, (loaded as CodexQuotaState).planType);
  if (type === 'antigravity' && loaded) {
    return getAntigravityPlanLabel((loaded as AntigravityQuotaState).subscription, t);
  }
  if (type === 'claude') {
    const planType = (loaded as ClaudeQuotaState | null)?.planType;
    if (planType) return t(`claude_quota.${planType}`);
    return file.plan ? file.plan.charAt(0).toUpperCase() + file.plan.slice(1) : null;
  }
  return null;
}

/** The renewal date of a loaded account's plan: "~Nov 21" when estimated. */
function useRenewal(
  type: QuotaProviderType | null,
  file: AuthFileItem,
  quota?: QuotaCardState
): { renewal: Renewal; now: number; date: string } | null {
  const { i18n } = useTranslation();
  const now = useNow();
  const liveActiveUntil =
    type === 'codex' && quota?.status === 'success'
      ? (quota as CodexQuotaState).subscriptionActiveUntil
      : null;
  const renewal = type && !file.disabled ? resolveRenewal(type, file, now, liveActiveUntil) : null;
  if (!renewal) return null;
  const date = new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language, {
    month: 'short',
    day: 'numeric',
  }).format(renewal.atMs);
  return { renewal, now, date: `${renewal.estimated ? '~' : ''}${date}` };
}

/** The multiplier chip, with the plan and our share on hover; nothing outside the pools. */
function PlanCell({
  label,
  file,
  type,
  quota,
}: {
  label: string | null;
  file: AuthFileItem;
  type: QuotaProviderType;
  quota?: QuotaCardState;
}) {
  const { t, i18n } = useTranslation();
  const renewing = useRenewal(type, file, quota);
  const share = supportsAuthFileUsageCap(type) ? planShareOf(file, 'weekly') : null;
  if (!share) return null;
  const soon = renewing && isRenewalSoon(renewing.renewal, renewing.now);
  return (
    <>
      <HoverCard
        focusable
        content={
          <>
            {label && <strong>{label}</strong>}
            <span className={styles.cardLine}>
              {planShareText(t, share, i18n.resolvedLanguage)}
            </span>
          </>
        }
      >
        <span className={`${styles.chip} ${share.multiplierSet ? '' : styles.chipUnset}`}>
          {formatMultiplier(share.multiplier, i18n.resolvedLanguage)}
        </span>
      </HoverCard>
      {soon && (
        <span
          className={renewalStyles.marker}
          role="img"
          aria-label={t('usage_accounts.renews_soon', { date: renewing.date })}
          title={t('usage_accounts.renews_soon', { date: renewing.date })}
        >
          ↻
        </span>
      )}
    </>
  );
}

/** "Max 5x" in the row, the email on hover with the file; the email in the details too. */
const rowName = (file: AuthFileItem) => {
  const identity = deriveAuthFileIdentity(file);
  const fileName = getQuotaDisplayName(file);
  const primary = identity.kind === 'fileName' ? '' : identity.primary;
  return {
    name: file.nickname || primary || fileName,
    mono: !file.nickname && !primary,
    title: [file.nickname ? primary : '', fileName].filter(Boolean).join('\n'),
    email: identity.kind === 'email' ? primary : '',
  };
};

/** The account half of a row's details: who it is, how it is pooled and routed. */
function AccountFacts({
  file,
  plan,
  quota,
}: {
  file: AuthFileItem;
  plan: string | null;
  quota?: QuotaCardState;
}) {
  const { t, i18n } = useTranslation();
  const type = resolveQuotaProviderType({ ...file, disabled: false });
  const renewing = useRenewal(type, file, quota);
  const share = type && supportsAuthFileUsageCap(type) ? planShareOf(file, 'weekly') : null;
  const { email } = rowName(file);
  return (
    <>
      {email && <DetailFact label={t('usage_accounts.details_email')}>{email}</DetailFact>}
      <DetailFact label={t('usage_accounts.details_file')}>
        <span className={styles.mono}>{getQuotaDisplayName(file)}</span>
      </DetailFact>
      {(plan || share) && (
        <DetailFact label={t('usage_accounts.details_plan')}>
          {[plan, share && planShareText(t, share, i18n.resolvedLanguage)]
            .filter(Boolean)
            .join(' · ')}
        </DetailFact>
      )}
      {renewing && (
        <DetailFact label={t('usage_accounts.details_renews')}>
          <span
            title={renewing.renewal.estimated ? t('usage_accounts.renews_estimated') : undefined}
          >
            {renewing.date}
          </span>
        </DetailFact>
      )}
      {file.lender && (
        <DetailFact label={t('usage_accounts.details_lender')}>{file.lender}</DetailFact>
      )}
      {file.routingStatus && (
        <DetailFact label={t('usage_accounts.details_routing')}>
          {[t(`routing.state_${file.routingStatus.state}`), file.routingStatus.reason]
            .filter(Boolean)
            .join(' · ')}
        </DetailFact>
      )}
    </>
  );
}

/** The spend split with amounts, and the window it covers. */
function SpendDetails({
  summary,
  spend,
}: {
  summary: SubscriptionSummary | null;
  spend: AccountSpendContext;
}) {
  const { t, i18n } = useTranslation();
  if (spend.status !== 'ready' || !summary) return null;
  const locale = i18n.resolvedLanguage;
  const span = summary.window
    ? `${new Date(summary.window.startMs).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} – ${new Date(summary.window.endMs).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
    : t('usage.sub_no_window', { range: spend.rangeName, span: spend.rangeSpan });
  return (
    <DetailFact label={t('usage_accounts.details_spend')}>
      <span className={styles.legend}>
        {summary.users.length === 0 && <span>{t('usage.sub_idle')}</span>}
        {summary.users.map((user) => (
          <span key={user.user || '\u0000'} className={styles.legendItem}>
            <span
              className={`${styles.swatch} ${slotClassName(spend.userSlots.get(user.user) ?? 'other')}`}
              aria-hidden="true"
            />
            {spend.userLabel(user.user)}
            <b>{formatUsd(user.costUsd, locale)}</b>
          </span>
        ))}
      </span>
      <span className={styles.muted}>{span}</span>
    </DetailFact>
  );
}

function DetailsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.detailsSection}>
      <h4 className={styles.detailsTitle}>{title}</h4>
      {children}
    </section>
  );
}

export interface QuotaAccountRowProps {
  entry: QuotaFileEntry;
  quota?: QuotaCardState;
  windows: AccountWindows;
  summary: SubscriptionSummary | null;
  spend: AccountSpendContext;
  resolvedTheme: ResolvedTheme;
  canRefresh: boolean;
  resetting: boolean;
  onRefresh: () => void;
  onReset: () => void;
  onFileChange: (key: string, patch: Partial<AuthFileItem>) => void;
  onSettingsSaved: () => void;
}

export function QuotaAccountRow(props: QuotaAccountRowProps) {
  const {
    entry,
    quota,
    windows,
    summary,
    spend,
    resolvedTheme,
    canRefresh,
    resetting,
    onRefresh,
    onReset,
    onFileChange,
    onSettingsSaved,
  } = props;
  const { t } = useTranslation();
  const nameId = useId();
  const adapter = QUOTA_ADAPTERS[entry.type];
  const file = entry.file;
  const label = planLabel(entry.type, quota, file, t);
  const status = quota?.status ?? 'idle';
  const loading = status === 'loading';
  const loaded = status === 'success' && quota !== undefined;

  const claudeReset = useClaudeResetGrants(
    file,
    entry.type === 'claude' && status !== 'idle',
    !canRefresh || loading || resetting,
    quota,
    onRefresh
  );
  const claudeGrants = loaded ? claudeReset.grants.filter((grant) => grant.resetsLeft > 0) : [];
  const codexQuota = loaded && entry.type === 'codex' ? (quota as CodexQuotaState) : null;
  const showReset =
    loaded && Boolean(adapter.resetQuota) && Boolean(adapter.canResetQuota?.(quota));
  const errorMessage =
    status === 'error'
      ? t(`${adapter.i18nPrefix}.load_failed`, {
          message: resolveQuotaErrorMessage(
            t,
            quota?.errorStatus,
            quota?.error || t('common.unknown_error')
          ),
        })
      : null;
  const pooled = supportsAuthFileUsageCap(entry.type);
  const share = pooled ? planShareOf(file, 'weekly') : null;

  const actions = (
    <>
      {entry.type === 'claude' && status !== 'idle' && (
        <RowIconButton
          label={
            claudeReset.buttonReason
              ? t('claude_reset.use_blocked', { reason: claudeReset.buttonReason })
              : t(`claude_reset.${claudeReset.buttonLabel}`)
          }
          disabled={claudeReset.blocked}
          onClick={() => claudeReset.confirm()}
        >
          <IconTimer size={14} aria-hidden="true" />
        </RowIconButton>
      )}
      {showReset && (
        <RowIconButton
          label={t('codex_quota.reset_button')}
          disabled={!canRefresh || loading || resetting}
          onClick={onReset}
        >
          <IconTimer size={14} aria-hidden="true" />
        </RowIconButton>
      )}
      <RowIconButton
        label={t('auth_files.quota_refresh_hint')}
        disabled={isQuotaRefreshDisabled(canRefresh, loading, resetting || claudeReset.busy)}
        onClick={onRefresh}
      >
        <IconRefreshCw size={14} aria-hidden="true" />
      </RowIconButton>
    </>
  );

  const windowsBody = errorMessage ? (
    <p className={styles.detailsError} role="alert">
      {errorMessage}
    </p>
  ) : loaded ? (
    <adapter.Body quota={quota} classes={quotaClasses} compact />
  ) : loading ? (
    <p className={styles.muted}>{t(`${adapter.i18nPrefix}.loading`)}</p>
  ) : (
    // Nothing loaded yet: a short line with the load action instead of an empty column.
    <p className={styles.muted}>
      <button
        type="button"
        className={styles.linkButton}
        disabled={isQuotaRefreshDisabled(canRefresh, loading, resetting)}
        onClick={onRefresh}
      >
        {t('usage_accounts.details_load')}
      </button>
    </p>
  );

  const details = (
    <>
      <DetailsSection title={t('usage_accounts.details_account')}>
        <AccountFacts file={file} plan={label} quota={quota} />
        <SpendDetails summary={summary} spend={spend} />
      </DetailsSection>

      <div className={styles.detailsColumn}>
        <DetailsSection title={t('usage_accounts.details_windows')}>{windowsBody}</DetailsSection>

        {(codexQuota || (entry.type === 'claude' && loaded)) && (
          <DetailsSection title={t('usage_accounts.details_resets')}>
            {entry.type === 'claude' && claudeGrants.length === 0 && (
              <DetailFact label={t('claude_reset.remaining')}>
                {claudeReset.count ?? '—'}
              </DetailFact>
            )}
            {claudeGrants.length > 0 && (
              <ClaudeResetGrantDetails
                grants={claudeGrants}
                classes={quotaClasses}
                blocker={claudeReset.grantBlocker}
                locked={claudeReset.locked}
                pendingGrantId={claudeReset.pendingGrantId}
                onRedeem={claudeReset.confirm}
              />
            )}
            {entry.type === 'claude' && claudeReset.message && (
              <p role="status" className={styles.muted}>
                {t(`claude_reset.${claudeReset.message}`)}
              </p>
            )}
            {entry.type === 'claude' && claudeReset.result && (
              <p role="status" className={styles.muted}>
                {t('claude_reset.last_result', { text: claudeReset.result })}
              </p>
            )}
            {codexQuota && !hasCodexDetails(codexQuota) && (
              <DetailFact label={t('codex_quota.reset_credits_label')}>
                {codexQuota.rateLimitResetCreditsAvailableCount ?? '—'}
              </DetailFact>
            )}
            {codexQuota && hasCodexDetails(codexQuota) && (
              <CodexQuotaDetails quota={codexQuota} classes={quotaClasses} />
            )}
          </DetailsSection>
        )}
      </div>
    </>
  );

  return (
    <AccountRow
      provider={entry.type}
      resolvedTheme={resolvedTheme}
      {...rowName(file)}
      nameId={nameId}
      file={file}
      plan={<PlanCell label={label} file={file} type={entry.type} quota={quota} />}
      windows={windows}
      capPercent={{
        short: pooled ? planShareOf(file, 'five_hour').capPercent : null,
        long: share?.capPercent ?? null,
      }}
      summary={summary}
      spend={spend}
      errorMessage={errorMessage}
      busy={loading || resetting}
      actions={actions}
      details={details}
      onFileChange={onFileChange}
      onSettingsSaved={onSettingsSaved}
    />
  );
}

/** Spend on a credential without quota support: no bars, the rest as a quota row. */
export function SpendAccountRow({
  summary,
  file,
  spend,
  resolvedTheme,
  onFileChange,
  onSettingsSaved,
}: {
  summary: SubscriptionSummary;
  file: AuthFileItem | null;
  spend: AccountSpendContext;
  resolvedTheme: ResolvedTheme;
  onFileChange: (key: string, patch: Partial<AuthFileItem>) => void;
  onSettingsSaved: () => void;
}) {
  const { t } = useTranslation();
  const nameId = useId();
  const { subscription } = summary;
  return (
    <AccountRow
      provider={subscription.provider}
      resolvedTheme={resolvedTheme}
      name={file?.nickname || subscription.name || subscription.id}
      title={file?.name ?? subscription.id}
      nameId={nameId}
      file={file}
      windows={{ short: null, long: null }}
      capPercent={{ short: null, long: null }}
      summary={summary}
      spend={spend}
      details={
        <DetailsSection title={t('usage_accounts.details_account')}>
          {file ? (
            <AccountFacts file={file} plan={null} />
          ) : (
            <DetailFact label={t('usage_accounts.details_file')}>
              <span className={styles.mono}>{subscription.id}</span>
            </DetailFact>
          )}
          <p className={styles.muted}>{t('usage_accounts.no_quota_support')}</p>
          <SpendDetails summary={summary} spend={spend} />
        </DetailsSection>
      }
      onFileChange={onFileChange}
      onSettingsSaved={onSettingsSaved}
    />
  );
}

/** A disabled credential: no quota or spend, dimmed, with its toggle off to re-enable it. */
export function DisabledAccountRow({
  file,
  spend,
  resolvedTheme,
  onFileChange,
  onSettingsSaved,
}: {
  file: AuthFileItem;
  spend: AccountSpendContext;
  resolvedTheme: ResolvedTheme;
  onFileChange: (key: string, patch: Partial<AuthFileItem>) => void;
  onSettingsSaved: () => void;
}) {
  const { t } = useTranslation();
  const nameId = useId();
  const type = resolveQuotaProviderType({ ...file, disabled: false });
  const provider = type ?? resolveAuthProvider(file);
  const label = type && planLabel(type, undefined, file, t);
  return (
    <AccountRow
      provider={provider}
      resolvedTheme={resolvedTheme}
      {...rowName(file)}
      nameId={nameId}
      file={file}
      plan={type && <PlanCell label={label} file={file} type={type} />}
      windows={{ short: null, long: null }}
      capPercent={{ short: null, long: null }}
      summary={null}
      spend={spend}
      details={
        <DetailsSection title={t('usage_accounts.details_account')}>
          <AccountFacts file={file} plan={label || null} />
          <p className={styles.muted}>
            {t(
              file.retiredAtMs !== undefined
                ? 'usage_accounts.retired_hint'
                : 'usage_accounts.disabled_hint'
            )}
          </p>
        </DetailsSection>
      }
      onFileChange={onFileChange}
      onSettingsSaved={onSettingsSaved}
    />
  );
}
