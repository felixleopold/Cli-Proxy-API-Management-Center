/**
 * The ⚙ popover of an account row: its name and usage settings only, saved
 * diff-only through PATCH /credentials/fields, then the credential list
 * reloads. Every field explains itself on hover or focus of its ⓘ. Below them,
 * Retire (after a confirmation) or, once retired, Reactivate.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { authFilesApi } from '@/services/api';
import { useNotificationStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import {
  CLAUDE_PLAN_WEIGHTS,
  isRuntimeOnlyAuthFile,
  type ClaudePlan,
} from '@/features/authFiles/constants';
import { notifyAuthFilesChanged } from '@/features/authFiles/authFilesEvents';
import {
  accountSettingsDraft,
  accountSettingsFields,
  buildAccountSettingsPatch,
  showsPlanMultiplier,
  type AccountSettingsDraft,
} from '../accountSettings';
import { InfoHint } from './HoverCard';
import styles from './AccountSettingsPopover.module.scss';

type TextField = Exclude<keyof AccountSettingsDraft, 'plan'>;

const CLAUDE_PLANS = Object.keys(CLAUDE_PLAN_WEIGHTS) as ClaudePlan[];

export function AccountSettingsPopover({
  file,
  provider,
  onClose,
  onSaved,
  statusPending,
  onRetire,
  onReactivate,
}: {
  file: AuthFileItem;
  provider: string;
  onClose: () => void;
  onSaved: () => void;
  statusPending: boolean;
  onRetire: () => void;
  onReactivate: () => void;
}) {
  const { t, i18n } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const id = useId();
  const rootRef = useRef<HTMLFormElement>(null);
  // Seeded once: a list reload while open must not overwrite what is being typed.
  const [seed] = useState(() => accountSettingsDraft(file));
  const [draft, setDraft] = useState(seed);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fields = accountSettingsFields(provider);
  // False once this popover closes: a save that resolves later must not close a newer one.
  const liveRef = useRef(true);

  // Closing by keyboard or button hands focus back to the ⚙ trigger.
  const closeToTrigger = useCallback(() => {
    const trigger = rootRef.current?.parentElement?.querySelector('button');
    onClose();
    trigger?.focus();
  }, [onClose]);

  useEffect(() => {
    liveRef.current = true;
    const root = rootRef.current;
    root?.querySelector('input')?.focus();
    const handlePointerDown = (event: MouseEvent) => {
      if (!root?.parentElement?.contains(event.target as Node)) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeToTrigger();
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      liveRef.current = false;
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, closeToTrigger]);

  const result = useMemo(
    () => buildAccountSettingsPatch(provider, seed, draft),
    [provider, seed, draft]
  );
  const dirty = result.patch !== undefined && Object.keys(result.patch).length > 0;

  const set = (key: keyof AccountSettingsDraft, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (result.error) {
      setError(t(`usage_accounts.settings_error_${result.error}`));
      return;
    }
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await authFilesApi.patchFields(file.name, result.patch);
      // The save landed either way; only a still-open popover closes itself.
      notifyAuthFilesChanged();
      showNotification(t('usage_accounts.settings_saved', { name: file.name }), 'success');
      onSaved();
      if (liveRef.current) closeToTrigger();
    } catch (err: unknown) {
      if (liveRef.current) setError(err instanceof Error ? err.message : t('common.unknown_error'));
    } finally {
      if (liveRef.current) setSaving(false);
    }
  };

  const fieldLabel = (key: keyof AccountSettingsDraft, label: string) => (
    <span className={styles.label}>
      <label htmlFor={`${id}-${key}`}>{label}</label>
      <InfoHint label={label} text={t(`usage_accounts.settings_hint_${key}`)} />
    </span>
  );

  const input = (
    key: TextField,
    label: string,
    options: { placeholder?: string; suffix?: string } = {}
  ) => {
    const text = key === 'lender' || key === 'nickname';
    return (
      <div className={styles.field}>
        {fieldLabel(key, label)}
        <span className={styles.inputWrap}>
          <input
            id={`${id}-${key}`}
            className={`${styles.input} ${text ? styles.inputText : ''}`}
            value={draft[key]}
            onChange={(event) => set(key, event.target.value)}
            placeholder={options.placeholder}
            inputMode={text ? 'text' : 'decimal'}
            autoComplete="off"
            spellCheck={false}
          />
          {options.suffix && <span className={styles.suffix}>{options.suffix}</span>}
        </span>
      </div>
    );
  };

  return (
    <form
      ref={rootRef}
      className={styles.popover}
      role="dialog"
      aria-labelledby={`${id}-title`}
      onSubmit={(event) => void submit(event)}
    >
      <header className={styles.head}>
        <span id={`${id}-title`} className={styles.title}>
          {t('usage_accounts.settings_title')}
        </span>
        <span className={styles.subject} title={file.name}>
          {file.name}
        </span>
      </header>

      <div className={styles.group}>
        {input('nickname', t('usage_accounts.settings_nickname'), {
          placeholder: file.email || t('usage_accounts.settings_nickname_placeholder'),
        })}
      </div>

      <div className={styles.group}>
        {input('priority', t('usage_accounts.settings_priority'), { placeholder: '0' })}
        {input('weight', t('usage_accounts.settings_weight'), { placeholder: '1' })}
      </div>

      {fields.pooled && (
        <div className={styles.group}>
          {fields.plan && (
            <div className={styles.field}>
              {fieldLabel('plan', t('usage_accounts.settings_plan'))}
              <select
                id={`${id}-plan`}
                className={styles.input}
                value={draft.plan}
                onChange={(event) => set('plan', event.target.value)}
              >
                {CLAUDE_PLANS.map((plan) => (
                  <option key={plan} value={plan}>
                    {t(`auth_files.plan_${plan}`, CLAUDE_PLAN_WEIGHTS[plan])}
                  </option>
                ))}
                {/* No plan: the multiplier below sizes the account. */}
                <option value="">{t('usage_accounts.settings_plan_custom')}</option>
                {/* A plan the gateway does not weigh stays selectable as typed. */}
                {draft.plan && !(CLAUDE_PLANS as string[]).includes(draft.plan) && (
                  <option value={draft.plan}>{draft.plan}</option>
                )}
              </select>
            </div>
          )}
          {showsPlanMultiplier(provider, draft.plan) &&
            input('planMultiplier', t('usage_accounts.settings_plan_multiplier'), {
              placeholder: '1',
              suffix: '×',
            })}
          {input('usageCap', t('usage_accounts.settings_usage_cap'), {
            placeholder: '—',
            suffix: '%',
          })}
        </div>
      )}

      {fields.pooled && (
        <div className={styles.group}>
          {input('lender', t('usage_accounts.settings_lender'), {
            placeholder: t('auth_files.lender_placeholder'),
          })}
          {input('reserveFiveHour', t('usage_accounts.settings_reserve_five_hour'), {
            placeholder: '—',
            suffix: '%',
          })}
          {input('reserveWeekly', t('usage_accounts.settings_reserve_weekly'), {
            placeholder: '—',
            suffix: '%',
          })}
        </div>
      )}

      {file.disabled && file.retiredAtMs !== undefined ? (
        <div className={`${styles.group} ${styles.lifecycle}`}>
          <span className={styles.lifecycleText}>
            {t('usage_accounts.retired_title', {
              date: new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              }).format(file.retiredAtMs),
            })}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={statusPending}
            onClick={() => {
              onReactivate();
              closeToTrigger();
            }}
          >
            {t('usage_accounts.reactivate')}
          </Button>
        </div>
      ) : (
        // Only credential files can be retired; the gateway refuses config API keys.
        !isRuntimeOnlyAuthFile(file) && (
          <div className={`${styles.group} ${styles.lifecycle}`}>
            <span className={styles.label}>
              <span>{t('usage_accounts.retire')}</span>
              <InfoHint label={t('usage_accounts.retire')} text={t('usage_accounts.retire_hint')} />
            </span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={statusPending}
              onClick={() => {
                onClose();
                showConfirmation({
                  title: t('usage_accounts.retire_confirm_title', {
                    name: file.nickname || file.email || file.name,
                  }),
                  message: t('usage_accounts.retire_confirm_message'),
                  confirmText: t('usage_accounts.retire'),
                  variant: 'danger',
                  onConfirm: onRetire,
                });
              }}
            >
              {t('usage_accounts.retire')}
            </Button>
          </div>
        )
      )}

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <footer className={styles.footer}>
        <span className={styles.hint}>{t('usage_accounts.settings_hint')}</span>
        <Button type="button" variant="ghost" size="sm" onClick={closeToTrigger}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={!(dirty || result.error) || saving}>
          {t('common.save')}
        </Button>
      </footer>
    </form>
  );
}
