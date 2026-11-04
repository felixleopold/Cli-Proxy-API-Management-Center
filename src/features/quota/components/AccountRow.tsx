/**
 * One account row on the Usage & quota page, shared by quota and spend-only
 * credentials: icon · account · plan · 5-hour and weekly bars · next reset ·
 * spend in the window · user split · enabled toggle · actions. Clicking the row
 * opens its details below it. The quota-specific parts (plan badge, actions,
 * details) come from QuotaAccountRow; this file is layout and the shared cells.
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
import { countdownParts, formatResetInstant } from '@/utils/quota/relativeTime';
import { DAY_MS } from '@/utils/time/durations';
import type { AccountWindow, AccountWindows } from '../accountCards';
import { AccountSettingsPopover } from './AccountSettingsPopover';
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
    <span
      className={`${styles.cell} ${styles.window}`}
      role="img"
      aria-label={t('usage_accounts.window_left_aria', { window: name, percent: left })}
      title={t('usage_accounts.window_left_aria', { window: name, percent: left })}
    >
      <span className={styles.windowValue}>
        {left}%{period && <span className={styles.windowPeriod}>{period}</span>}
      </span>
      <span className={styles.bar}>
        <span className={`${styles.barFill} ${level}`} style={{ width: `${left}%` }} />
        {capPercent !== null && capPercent > 0 && capPercent < 100 && (
          // Our share runs out once what is left falls to the lender's reserve.
          <span className={styles.barTick} style={{ left: `${100 - capPercent}%` }} />
        )}
      </span>
    </span>
  );
}

/** "Fri 16:00 · 1d 3h": the instant and the countdown, never whole days alone. */
export function ResetCell({ resetAtMs }: { resetAtMs: number | null }) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const parts = resetAtMs === null ? null : countdownParts(resetAtMs, now);
  if (resetAtMs === null || !parts) {
    return <span className={`${styles.cell} ${styles.unknown}`}>—</span>;
  }
  const countdown =
    parts.days > 0
      ? t('usage_accounts.countdown_days', { days: parts.days, hours: parts.hours })
      : parts.hours > 0
        ? t('usage_accounts.countdown_hours', { hours: parts.hours, minutes: parts.minutes })
        : t('usage_accounts.countdown_minutes', { minutes: parts.minutes });
  return (
    <span
      className={`${styles.cell} ${styles.reset}`}
      title={new Date(resetAtMs).toLocaleString(i18n.resolvedLanguage)}
    >
      <span>{formatResetInstant(resetAtMs, now, i18n.resolvedLanguage)}</span>
      <span className={styles.muted}>· {countdown}</span>
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
  const content = (
    <>
      <span className={styles.spendValue}>{formatUsd(summary.costUsd, locale)}</span>
      {summary.estimateUsd !== null && (
        <span
          className={styles.muted}
          title={t('usage.sub_estimate_hint', { percent: formatPercent(usedPercent ?? 0, 0) })}
        >
          {t('usage.sub_estimate', { amount: formatUsd(summary.estimateUsd, locale, true) })}
        </span>
      )}
    </>
  );
  const stale = spend.stale ? styles.stale : '';
  if (!window) {
    return (
      <span
        className={`${styles.cell} ${styles.spend} ${stale}`}
        title={t('usage.sub_no_window', { range: spend.rangeName, span: spend.rangeSpan })}
      >
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`${styles.cell} ${styles.spend} ${styles.spendButton} ${stale}`}
      aria-pressed={spend.activeId === subscription.id}
      aria-label={`${t('usage.sub_open')}: ${formatUsd(summary.costUsd, locale)} ${t('usage.sub_spend_window')}`}
      aria-describedby={labelId}
      title={t('usage.sub_open')}
      onClick={() => spend.onSelect(subscription.id)}
    >
      {content}
    </button>
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
  const breakdown = summary.users
    .map(
      (user) => `${spend.userLabel(user.user)} ${formatUsd(user.costUsd, i18n.resolvedLanguage)}`
    )
    .join(' · ');
  return (
    <span
      className={styles.cell}
      role="img"
      aria-label={t('usage_accounts.split_aria', { breakdown })}
      title={breakdown}
    >
      <span className={styles.split}>
        {summary.users.map((user) => (
          <span
            key={user.user || '\u0000'}
            className={`${styles.splitPart} ${slotClassName(spend.userSlots.get(user.user) ?? 'other')}`}
            style={{ flexGrow: user.costUsd }}
          />
        ))}
      </span>
    </span>
  );
}

/* ---------- Enabled toggle ---------- */

/** PATCH /credentials/status with an optimistic flip, as Auth Files does. */
function StatusToggle({
  file,
  onFileChange,
}: {
  file: AuthFileItem;
  onFileChange: (key: string, patch: Partial<AuthFileItem>) => void;
}) {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const lock = useAccountStatusLock();
  const key = getQuotaCacheKey(file);
  const pending = lock.isPending(key);
  const enabled = file.disabled !== true;

  const toggle = async (next: boolean) => {
    if (!lock.begin(key)) return;
    const revision = apiClient.getConnectionRevision();
    const { name } = file;
    onFileChange(key, { disabled: !next });
    try {
      const res = await authFilesApi.setStatus(
        name,
        !next,
        String(file.authIndex ?? '').trim() || undefined
      );
      if (revision !== apiClient.getConnectionRevision()) return;
      onFileChange(key, { disabled: res.disabled });
      notifyAuthFilesChanged();
      showNotification(
        next
          ? t('auth_files.status_enabled_success', { name })
          : t('auth_files.status_disabled_success', { name }),
        'success'
      );
    } catch (err: unknown) {
      if (revision !== apiClient.getConnectionRevision()) return;
      onFileChange(key, { disabled: !enabled });
      const message = err instanceof Error ? err.message : '';
      showNotification(`${t('notification.update_failed')}: ${message}`, 'error');
    } finally {
      lock.end(key);
    }
  };

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
  /** The account's display name (email where known). */
  name: string;
  /** On hover: the credential's file name. */
  title: string;
  nameId: string;
  mono?: boolean;
  /** The listed credential; null for spend the listing no longer has. */
  file: AuthFileItem | null;
  plan?: ReactNode;
  windows: AccountWindows;
  /** Our share of each window, for the reserve tick. */
  capPercent: { short: number | null; long: number | null };
  resetAtMs: number | null;
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
    resetAtMs,
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
          <IconChevronRight size={12} aria-hidden="true" className={styles.chevron} />
        </button>
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
        <ResetCell resetAtMs={resetAtMs} />
        <SpendCell summary={summary} spend={spend} labelId={nameId} />
        <SplitCell summary={summary} spend={spend} />
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
                  <AccountSettingsPopover
                    file={file}
                    provider={provider}
                    onClose={closeSettings}
                    onSaved={onSettingsSaved}
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
