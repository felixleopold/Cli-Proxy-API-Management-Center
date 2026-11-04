/**
 * The ⚙ popover of an account row: its usage settings only, saved diff-only
 * through PATCH /credentials/fields, then the credential list reloads.
 */

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { authFilesApi } from '@/services/api';
import { useNotificationStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { CLAUDE_PLAN_WEIGHTS, type ClaudePlan } from '@/features/authFiles/constants';
import { notifyAuthFilesChanged } from '@/features/authFiles/authFilesEvents';
import {
  accountSettingsDraft,
  accountSettingsFields,
  buildAccountSettingsPatch,
  type AccountSettingsDraft,
} from '../accountSettings';
import styles from './AccountSettingsPopover.module.scss';

type TextField = Exclude<keyof AccountSettingsDraft, 'plan'>;

const CLAUDE_PLANS = Object.keys(CLAUDE_PLAN_WEIGHTS) as ClaudePlan[];

export function AccountSettingsPopover({
  file,
  provider,
  onClose,
  onSaved,
}: {
  file: AuthFileItem;
  provider: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const id = useId();
  const rootRef = useRef<HTMLFormElement>(null);
  // Seeded once: a list reload while open must not overwrite what is being typed.
  const [seed] = useState(() => accountSettingsDraft(file));
  const [draft, setDraft] = useState(seed);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fields = accountSettingsFields(provider);

  useEffect(() => {
    const root = rootRef.current;
    root?.querySelector('input')?.focus();
    const anchor = root?.parentElement?.querySelector('button');
    const handlePointerDown = (event: MouseEvent) => {
      if (!root?.parentElement?.contains(event.target as Node)) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      onClose();
      anchor?.focus();
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

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
      notifyAuthFilesChanged();
      showNotification(t('usage_accounts.settings_saved', { name: file.name }), 'success');
      onSaved();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('common.unknown_error'));
    } finally {
      setSaving(false);
    }
  };

  const input = (
    key: TextField,
    label: string,
    options: { placeholder?: string; suffix?: string } = {}
  ) => (
    <label className={styles.field} htmlFor={`${id}-${key}`}>
      <span className={styles.label}>{label}</span>
      <span className={styles.inputWrap}>
        <input
          id={`${id}-${key}`}
          className={`${styles.input} ${key === 'lender' ? styles.inputText : ''}`}
          value={draft[key]}
          onChange={(event) => set(key, event.target.value)}
          placeholder={options.placeholder}
          inputMode={key === 'lender' ? 'text' : 'decimal'}
          autoComplete="off"
          spellCheck={false}
        />
        {options.suffix && <span className={styles.suffix}>{options.suffix}</span>}
      </span>
    </label>
  );

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
        {input('priority', t('usage_accounts.settings_priority'), { placeholder: '0' })}
        {input('weight', t('usage_accounts.settings_weight'), { placeholder: '1' })}
      </div>

      {fields.pooled && (
        <div className={styles.group}>
          {fields.plan && (
            <label className={styles.field} htmlFor={`${id}-plan`}>
              <span className={styles.label}>{t('usage_accounts.settings_plan')}</span>
              <select
                id={`${id}-plan`}
                className={styles.input}
                value={draft.plan}
                onChange={(event) => set('plan', event.target.value)}
              >
                <option value="">{t('usage_accounts.settings_plan_unset')}</option>
                {CLAUDE_PLANS.map((plan) => (
                  <option key={plan} value={plan}>
                    {t(`auth_files.plan_${plan}`, CLAUDE_PLAN_WEIGHTS[plan])}
                  </option>
                ))}
                {/* A plan the gateway does not weigh stays selectable as typed. */}
                {draft.plan && !(CLAUDE_PLANS as string[]).includes(draft.plan) && (
                  <option value={draft.plan}>{draft.plan}</option>
                )}
              </select>
            </label>
          )}
          {input('planMultiplier', t('usage_accounts.settings_plan_multiplier'), {
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

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <footer className={styles.footer}>
        <span className={styles.hint}>{t('usage_accounts.settings_hint')}</span>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={!(dirty || result.error) || saving}>
          {t('common.save')}
        </Button>
      </footer>
    </form>
  );
}
