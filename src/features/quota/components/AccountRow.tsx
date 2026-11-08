/**
 * One account row on the Usage & quota page, shared by quota and spend-only
 * credentials: icon · routing dot and name · multiplier · 5-hour and weekly
 * bars, each with its reset · spend in the window · user split · pace · enabled
 * toggle · actions. Clicking the row opens its details below it. The
 * quota-specific parts (plan chip, actions, details) come from QuotaAccountRow;
 * this file is layout and the shared cells.
 */

import { useCallback, useState, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IconAlertTriangle, IconChevronRight, IconSettings } from '@/components/ui/icons';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useNow } from '@/hooks/useNow';
import { apiClient, authFilesApi } from '@/services/api';
import { useNotificationStore } from '@/stores';
import type { AuthFileItem, ResolvedTheme } from '@/types';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { notifyAuthFilesChanged } from '@/features/authFiles/authFilesEvents';
import type { AccountSpendContext } from '@/features/usage/components/AccountSpend';
import { slotClassName } from '@/features/usage/components/slotClass';
import { formatUsd, type SubscriptionSummary } from '@/features/usage/usageModel';
import { formatPercent } from '@/utils/format';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { DAY_MS } from '@/utils/time/durations';
import { nextResetsOf, type AccountWindow, type AccountWindows } from '../accountCards';
import { AccountSettingsPopover } from './AccountSettingsPopover';
import { formatCountdown, formatWhen } from './countdown';
import { HoverCard } from './HoverCard';
import { PaceControl } from './PaceControl';
import { useAccountStatusLock } from './accountStatusLock';
import styles from './Accounts.module.scss';

/* ---------- Cells ---------- */

function ProviderIcon({
  provider,
  resolvedTheme,
}: {
  provider: string;
  resolvedTheme: ResolvedTheme;
}) {
  const { t } = useTranslation();
  const iconSrc = getAuthFileIcon(provider, resolvedTheme);
  const typeLabel = getTypeLabel(t, provider);
  return (
    <span
      className={styles.icon}
      title={typeLabel}
      style={
        isThemeSurfaceIconProvider(provider)
          ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
          : undefined
      }
    >
      {iconSrc ? (
        <img src={iconSrc} alt="" />
      ) : (
        <span className={styles.iconFallback}>{typeLabel.slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  );
}

/** Weekly windows are 6–8 days; any other long window names its length on the bar. */
const isWeekly = (periodMs: number) => periodMs >= 6 * DAY_MS && periodMs <= 8 * DAY_MS;

function WindowCell({
  window,
  name,
  capPercent,
  long,
}: {
  window: AccountWindow | null;
  name: string;
  /** Our share of the window; a tick marks it when the lender keeps a reserve. */
  capPercent: number | null;
  long?: boolean;
}) {
  const { t } = useTranslation();
  if (!window) {
    return (
      <span
        className={`${styles.cell} ${styles.unknown}`}
        title={t('usage_accounts.window_unknown')}
      >
        —
      </span>
    );
  }
  const left = Math.round(window.leftPercent);
  const level = left < 10 ? styles.barLow : left < 30 ? styles.barWarn : '';
  const days = Math.round(window.periodMs / DAY_MS);
  const period = long && !isWeekly(window.periodMs) && days >= 1 ? `${days}d` : null;
  return (
    <span className={`${styles.cell} ${styles.window}`}>
      <span
        className={styles.windowValue}
        role="img"
        aria-label={t('usage_accounts.window_left_aria', { window: name, percent: left })}
      >
        {left}%{period && <span className={styles.windowPeriod}>{period}</span>}
      </span>
      <span className={styles.bar} aria-hidden="true">
        <span className={`${styles.barFill} ${level}`} style={{ width: `${left}%` }} />
        {capPercent !== null && capPercent > 0 && capPercent < 100 && (
          // Our share runs out once what is left falls to the lender's reserve.
          <span className={styles.barTick} style={{ left: `${100 - capPercent}%` }} />
        )}
      </span>
      <ResetLine resetAtMs={window.resetAtMs} />
    </span>
  );
}

/** "Fri 16:00 · 1d 3h" under a bar: the instant and the countdown; the full date on hover. */
function ResetLine({ resetAtMs }: { resetAtMs: number | null }) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const countdown = resetAtMs === null ? null : formatCountdown(t, resetAtMs, now);
  if (resetAtMs === null || !countdown) {
    // An idle 5-hour window starts with the next request.
    return <span className={styles.resetLine}>{t('usage_accounts.reset_idle')}</span>;
  }
  return (
    <span
      className={styles.resetLine}
      title={t('usage_accounts.reset_exact', {
        time: new Date(resetAtMs).toLocaleString(i18n.resolvedLanguage, {
          dateStyle: 'full',
          timeStyle: 'short',
        }),
      })}
    >
      {formatWhen(resetAtMs, now, i18n.resolvedLanguage)} · {countdown}
    </span>
  );
}

function SpendCell({
  summary,
  spend,
  labelId,
}: {
  summary: SubscriptionSummary | null;
  spend: AccountSpendContext;
  labelId: string;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  if (spend.status === 'loading') return <span className={styles.placeholder} aria-hidden="true" />;
  if (spend.status === 'unavailable' || !summary) {
    return <span className={`${styles.cell} ${styles.unknown}`}>—</span>;
  }
  const { window, subscription, usedPercent } = summary;
  const amount = formatUsd(summary.costUsd, locale);
  const stale = spend.stale ? styles.stale : '';
  const explanation = (
    <>
      {summary.estimateUsd !== null && (
        <span className={styles.cardLine}>
          <b>{t('usage.sub_estimate', { amount: formatUsd(summary.estimateUsd, locale, true) })}</b>
          <br />
          {t('usage.sub_estimate_hint', { percent: formatPercent(usedPercent ?? 0, 0) })}
        </span>
      )}
      <span className={styles.cardLine}>
        {window
          ? t('usage_accounts.spend_open_hint')
          : t('usage.sub_no_window', { range: spend.rangeName, span: spend.rangeSpan })}
      </span>
    </>
  );
  return (
    <HoverCard content={explanation} className={styles.cell} focusable={!window}>
      {window ? (
        <button
          type="button"
          className={`${styles.spend} ${styles.spendButton} ${stale}`}
          aria-pressed={spend.activeId === subscription.id}
          aria-label={`${t('usage.sub_open')}: ${amount} ${t('usage.sub_spend_window')}`}
          aria-describedby={labelId}
          onClick={() => spend.onSelect(subscription.id)}
        >
          <span className={styles.spendValue}>{amount}</span>
        </button>
      ) : (
        <span className={`${styles.spend} ${stale}`}>
          <span className={styles.spendValue}>{amount}</span>
        </span>
      )}
    </HoverCard>
  );
}

/** Who spent the window, as a small stacked bar; the amounts are in its tooltip. */
function SplitCell({
  summary,
  spend,
}: {
  summary: SubscriptionSummary | null;
  spend: AccountSpendContext;
}) {
  const { t, i18n } = useTranslation();
  if (spend.status !== 'ready' || !summary || summary.costUsd <= 0) {
    return <span className={styles.cell} />;
  }
  const locale = i18n.resolvedLanguage;
  const breakdown = summary.users
    .map((user) => `${spend.userLabel(user.user)} ${formatUsd(user.costUsd, locale)}`)
    .join(' · ');
  const card = (
    <span className={styles.splitCard}>
      {summary.users.map((user) => (
        <span key={user.user || '\u0000'} className={styles.splitCardRow}>
          <span
            className={`${styles.swatch} ${slotClassName(spend.userSlots.get(user.user) ?? 'other')}`}
            aria-hidden="true"
          />
          <span>{spend.userLabel(user.user)}</span>
          <b>{formatUsd(user.costUsd, locale)}</b>
          <span className={styles.muted}>
            {formatPercent((user.costUsd / summary.costUsd) * 100, 0)}
          </span>
        </span>
      ))}
    </span>
  );
  return (
    <HoverCard
      content={card}
      className={`${styles.cell} ${styles.splitCell}`}
      align="end"
      focusable
    >
      <span
        className={styles.split}
        role="img"
        aria-label={t('usage_accounts.split_aria', { breakdown })}
      >
        {summary.users.map((user) => (
          <span
            key={user.user || '\u0000'}
            className={`${styles.splitPart} ${slotClassName(spend.userSlots.get(user.user) ?? 'other')}`}
            style={{ flexGrow: user.costUsd }}
          />
        ))}
      </span>
    </HoverCard>
  );
}

/* ---------- Routing status ---------- */

/**
 * The gateway's routing status as a small dot before the name, with a card on
 * why and until when. "target" is where the provider's requests go right now.
 */
function RoutingDot({ file }: { file: AuthFileItem }) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const status = file.routingStatus;
  if (!status) return null;
  const label = t(`routing.state_${status.state}`);
  const left = status.untilMs !== undefined ? formatCountdown(t, status.untilMs, now) : null;
  const card = (
    <>
      <strong>{label}</strong>
      <span className={styles.cardLine}>{t(`routing.explain_${status.state}`)}</span>
      {status.reason && <span className={styles.cardLine}>{status.reason}</span>}
      {status.untilMs !== undefined && left && (
        <span className={styles.cardLine}>
          {t('routing.until', {
            time: formatWhen(status.untilMs, now, i18n.resolvedLanguage),
            left,
          })}
        </span>
      )}
    </>
  );
  return (
    <HoverCard content={card} focusable className={styles.dotAnchor}>
      <span
        className={styles.routingDot}
        data-state={status.state}
        role="img"
        aria-label={t('routing.aria', { state: label })}
      />
    </HoverCard>
  );
}

/* ---------- Enabled toggle ---------- */

/** What enabling, disabling or retiring a credential does, for its notification. */
type StatusChange = 'enable' | 'disable' | 'retire';

const STATUS_SUCCESS: Record<StatusChange, string> = {
  enable: 'auth_files.status_enabled_success',
  disable: 'auth_files.status_disabled_success',
  retire: 'usage_accounts.retire_success',
};

/**
 * PATCH /credentials/status with an optimistic flip, as Auth Files does.
 * Enabling a retired credential reactivates it: the gateway clears retired_at.
 */
function useStatusChange(
  file: AuthFileItem,
  onFileChange: (key: string, patch: Partial<AuthFileItem>) => void
) {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const lock = useAccountStatusLock();
  const key = getQuotaCacheKey(file);

  const change = async (next: StatusChange) => {
    if (!lock.begin(key)) return;
    const revision = apiClient.getConnectionRevision();
    const { name } = file;
    const previous = { disabled: file.disabled, retiredAtMs: file.retiredAtMs };
    onFileChange(
      key,
      next === 'enable' ? { disabled: false, retiredAtMs: undefined } : { disabled: true }
    );
    try {
      const res = await authFilesApi.setStatus(
        name,
        next !== 'enable',
        String(file.authIndex ?? '').trim() || undefined,
        next === 'retire'
      );
      if (revision !== apiClient.getConnectionRevision()) return;
      onFileChange(key, { disabled: res.disabled, retiredAtMs: res.retiredAtMs });
      notifyAuthFilesChanged();
      showNotification(t(STATUS_SUCCESS[next], { name }), 'success');
    } catch (err: unknown) {
      if (revision !== apiClient.getConnectionRevision()) return;
      onFileChange(key, previous);
      const message = err instanceof Error ? err.message : '';
      showNotification(`${t('notification.update_failed')}: ${message}`, 'error');
    } finally {
      lock.end(key);
    }
  };

  return { pending: lock.isPending(key), change };
}

function StatusToggle({
  file,
  onFileChange,
}: {
  file: AuthFileItem;
  onFileChange: (key: string, patch: Partial<AuthFileItem>) => void;
}) {
  const { t } = useTranslation();
  const { pending, change } = useStatusChange(file, onFileChange);
  const enabled = file.disabled !== true;
  const toggle = (next: boolean) => change(next ? 'enable' : 'disable');

  return (
    <span className={styles.toggle}>
      <ToggleSwitch
        checked={enabled}
        onChange={(next) => void toggle(next)}
        disabled={pending}
        ariaLabel={t('usage_accounts.enabled_aria', { name: file.name })}
      />
    </span>
  );
}

/* ---------- Row ---------- */

export interface AccountRowProps {
  provider: string;
  resolvedTheme: ResolvedTheme;
  /** The account's display name: its nickname, else its email, else its file name. */
  name: string;
  /** On hover: the email and the credential's file name. */
  title: string;
  nameId: string;
  mono?: boolean;
  /** The listed credential; null for spend the listing no longer has. */
  file: AuthFileItem | null;
  plan?: ReactNode;
  windows: AccountWindows;
  /** Our share of each window, for the reserve tick. */
  capPercent: { short: number | null; long: number | null };
  summary: SubscriptionSummary | null;
  spend: AccountSpendContext;
  /** The quota failed to load; the details say why. */
  errorMessage?: string | null;
  busy?: boolean;
  /** Refresh and reset buttons. */
  actions?: ReactNode;
  details: ReactNode;
  onFileChange: (key: string, patch: Partial<AuthFileItem>) => void;
  onSettingsSaved: () => void;
}

/** Clicks on the row's own controls do not toggle its details. */
const isControl = (event: MouseEvent) =>
  (event.target as HTMLElement).closest('button, a, input, select, label, [data-row-control]') !==
  null;

export function AccountRow(props: AccountRowProps) {
  const {
    provider,
    resolvedTheme,
    name,
    title,
    nameId,
    mono,
    file,
    plan,
    windows,
    capPercent,
    summary,
    spend,
    errorMessage,
    busy,
    actions,
    details,
    onFileChange,
    onSettingsSaved,
  } = props;
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Stable, so the popover's listeners and initial focus do not rerun on every render.
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const detailsId = `${nameId}-details`;
  const disabled = file?.disabled === true;
  const retiredAtMs = file?.disabled ? file.retiredAtMs : undefined;

  return (
    <li
      className={styles.item}
      data-disabled={disabled || undefined}
      data-active={(summary !== null && spend.activeId === summary.subscription.id) || undefined}
      data-expanded={expanded || undefined}
      aria-busy={busy || undefined}
    >
      <div
        className={styles.row}
        onClick={(event) => {
          if (!isControl(event)) setExpanded((open) => !open);
        }}
      >
        <ProviderIcon provider={provider} resolvedTheme={resolvedTheme} />
        <span className={styles.identity}>
          {file && <RoutingDot file={file} />}
          <button
            type="button"
            className={styles.account}
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded((open) => !open)}
          >
            <span id={nameId} className={`${styles.name} ${mono ? styles.mono : ''}`} title={title}>
              {name}
            </span>
            {errorMessage && (
              <IconAlertTriangle
                size={12}
                className={styles.errorIcon}
                aria-label={errorMessage}
                role="img"
              />
            )}
            {retiredAtMs !== undefined && <RetiredBadge atMs={retiredAtMs} />}
            <IconChevronRight size={12} aria-hidden="true" className={styles.chevron} />
          </button>
        </span>
        <span className={`${styles.cell} ${styles.plan}`}>{plan}</span>
        <WindowCell
          window={windows.short}
          name={t('usage_accounts.col_five_hour')}
          capPercent={capPercent.short}
        />
        <WindowCell
          window={windows.long}
          name={t('usage_accounts.col_weekly')}
          capPercent={capPercent.long}
          long
        />
        <SpendCell summary={summary} spend={spend} labelId={nameId} />
        <SplitCell summary={summary} spend={spend} />
        {file ? (
          <PaceControl
            file={file}
            resets={nextResetsOf(windows)}
            onChange={(patch) => onFileChange(getQuotaCacheKey(file), patch)}
            onReload={onSettingsSaved}
          />
        ) : (
          <span />
        )}
        <span className={styles.controls}>
          {file ? <StatusToggle file={file} onFileChange={onFileChange} /> : <span />}
          <span className={styles.actions}>
            {actions}
            {file && (
              <span className={styles.settingsAnchor} data-row-control>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label={t('usage_accounts.settings_open', { name })}
                  title={t('usage_accounts.settings_title')}
                  aria-expanded={settingsOpen}
                  aria-haspopup="dialog"
                  onClick={() => setSettingsOpen((open) => !open)}
                >
                  <IconSettings size={14} aria-hidden="true" />
                </button>
                {settingsOpen && (
                  <RowSettings
                    file={file}
                    provider={provider}
                    onClose={closeSettings}
                    onSaved={onSettingsSaved}
                    onFileChange={onFileChange}
                  />
                )}
              </span>
            )}
          </span>
        </span>
      </div>
      {expanded && (
        <div id={detailsId} className={styles.details}>
          {details}
        </div>
      )}
    </li>
  );
}

/** "Retired · Nov 8": the credential is out of the pool, its history and settings kept. */
export function RetiredBadge({ atMs }: { atMs: number }) {
  const { t, i18n } = useTranslation();
  const date = new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language, {
    month: 'short',
    day: 'numeric',
  }).format(atMs);
  return (
    <span className={styles.retiredBadge} title={t('usage_accounts.retired_title', { date })}>
      {t('usage_accounts.retired_badge', { date })}
    </span>
  );
}

/** The ⚙ popover with the row's status change, so Retire and Reactivate share the toggle's lock. */
function RowSettings({
  file,
  onFileChange,
  ...props
}: {
  file: AuthFileItem;
  provider: string;
  onClose: () => void;
  onSaved: () => void;
  onFileChange: (key: string, patch: Partial<AuthFileItem>) => void;
}) {
  const { pending, change } = useStatusChange(file, onFileChange);
  return (
    <AccountSettingsPopover
      file={file}
      {...props}
      statusPending={pending}
      onRetire={() => void change('retire')}
      onReactivate={() => void change('enable')}
    />
  );
}

/** An icon button in the row's action group. */
export function RowIconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={styles.iconButton}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** A labelled fact in a row's details. */
export function DetailFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.fact}>
      <span className={styles.factLabel}>{label}</span>
      <span className={styles.factValue}>{children}</span>
    </div>
  );
}
