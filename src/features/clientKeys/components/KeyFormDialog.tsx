import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AutocompleteInput } from '@/components/ui/AutocompleteInput';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { IconX } from '@/components/ui/icons';
import type { ClientKey, ClientKeyCredentials, ClientKeyInput } from '@/services/api/clientKeys';
import { getErrorMessage } from '@/utils/helpers';
import { addModelPatterns, isValidModelPattern } from '../clientKeysModel';
import styles from './KeyFormDialog.module.scss';

interface KeyFormDialogProps {
  /** null creates a key. */
  editing: ClientKey | null;
  projects: string[];
  onClose: () => void;
  /** Rejects with the gateway's message, shown in the form. */
  onSubmit: (input: ClientKeyInput) => Promise<void>;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** `YYYY-MM-DD` of an instant in local time, for the date input. */
const localDate = (ms: number) => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** The key stops working at local midnight starting the chosen day. */
const expiryIso = (date: string) => {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day).toISOString();
};

/**
 * Create or edit a key. Rendered only while open, so every opening starts from the key's
 * current values.
 */
export function KeyFormDialog({ editing, projects, onClose, onSubmit }: KeyFormDialogProps) {
  const { t } = useTranslation();
  const modelsId = useId();
  const projectId = useId();
  const [name, setName] = useState(editing?.name ?? '');
  const [project, setProject] = useState(editing?.project ?? '');
  const [models, setModels] = useState<string[]>(editing?.models ?? []);
  const [modelDraft, setModelDraft] = useState('');
  const [budget, setBudget] = useState(
    editing && editing.monthlyBudgetUsd > 0 ? String(editing.monthlyBudgetUsd) : ''
  );
  const [credentials, setCredentials] = useState<ClientKeyCredentials>(
    editing?.credentials ?? 'api-key'
  );
  const initialExpiry = editing?.expiresAtMs ? localDate(editing.expiresAtMs) : '';
  const [expiry, setExpiry] = useState(initialExpiry);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  // Blocks a second submit (e.g. a repeated Enter) before `saving` re-renders: each create
  // mints a key, and a later reveal would replace the first one-time secret.
  const inFlightRef = useRef(false);
  const [error, setError] = useState('');

  const allModels = addModelPatterns(models, modelDraft);
  const invalidModels = allModels.filter((model) => !isValidModelPattern(model));
  const budgetValue = budget.trim() === '' ? 0 : Number(budget);
  const budgetInvalid = !Number.isFinite(budgetValue) || budgetValue < 0;
  const nameInvalid = name.trim() === '';

  const commitDraft = () => {
    if (!modelDraft.trim()) return;
    setModels(allModels);
    setModelDraft('');
  };

  const handleModelKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commitDraft();
    } else if (event.key === 'Backspace' && modelDraft === '' && models.length > 0) {
      setModels(models.slice(0, -1));
    }
  };

  const handleSubmit = async (event?: FormEvent) => {
    event?.preventDefault();
    setSubmitted(true);
    if (inFlightRef.current || nameInvalid || budgetInvalid || invalidModels.length > 0) return;
    inFlightRef.current = true;
    setSaving(true);
    setError('');
    try {
      await onSubmit({
        name: name.trim(),
        project: project.trim(),
        models: allModels,
        credentials,
        monthlyBudgetUsd: budgetValue,
        // An unchanged date keeps the exact original instant.
        expiresAt:
          expiry === ''
            ? ''
            : expiry === initialExpiry && editing?.expiresAtMs
              ? new Date(editing.expiresAtMs).toISOString()
              : expiryIso(expiry),
      });
    } catch (err: unknown) {
      setError(getErrorMessage(err, t('common.unknown_error')));
      inFlightRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      closeDisabled={saving}
      width={600}
      title={
        editing
          ? t('client_keys.form_edit_title', { name: editing.name })
          : t('client_keys.form_create_title')
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={saving}>
            {saving
              ? t('client_keys.form_saving')
              : editing
                ? t('client_keys.form_save')
                : t('client_keys.form_create')}
          </Button>
        </>
      }
    >
      <form onSubmit={(event) => void handleSubmit(event)}>
        <fieldset className={styles.form} disabled={saving}>
          <div className={styles.row}>
            <Input
              label={t('client_keys.field_name')}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('client_keys.field_name_placeholder')}
              error={submitted && nameInvalid ? t('client_keys.field_name_required') : undefined}
              autoFocus
            />
            <AutocompleteInput
              id={projectId}
              label={t('client_keys.field_project')}
              value={project}
              onChange={setProject}
              options={projects}
              placeholder={t('client_keys.field_project_placeholder')}
              hint={t('client_keys.field_project_hint')}
            />
          </div>

          <div className="form-group">
            <label htmlFor={modelsId}>{t('client_keys.field_models')}</label>
            <div className={styles.tags}>
              {models.map((model) => (
                <span
                  key={model}
                  className={
                    isValidModelPattern(model) ? styles.tag : `${styles.tag} ${styles.tagInvalid}`
                  }
                >
                  {model}
                  <button
                    type="button"
                    className={styles.tagRemove}
                    onClick={() => setModels(models.filter((item) => item !== model))}
                    aria-label={t('client_keys.field_models_remove', { model })}
                  >
                    <IconX size={12} />
                  </button>
                </span>
              ))}
              <input
                id={modelsId}
                className={styles.tagInput}
                value={modelDraft}
                onChange={(event) => setModelDraft(event.target.value)}
                onKeyDown={handleModelKey}
                onBlur={commitDraft}
                placeholder={
                  models.length === 0 ? t('client_keys.field_models_placeholder') : undefined
                }
              />
            </div>
            <div className="hint">{t('client_keys.field_models_hint')}</div>
            {submitted && invalidModels.length > 0 && (
              <div className="error-box">
                {t('client_keys.field_models_invalid', { models: invalidModels.join(', ') })}
              </div>
            )}
          </div>

          <div className={styles.row}>
            <Input
              label={t('client_keys.field_budget')}
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
              placeholder={t('client_keys.field_budget_placeholder')}
              hint={t('client_keys.field_budget_hint')}
              error={submitted && budgetInvalid ? t('client_keys.field_budget_invalid') : undefined}
            />
            <Input
              label={t('client_keys.field_expiry')}
              type="date"
              value={expiry}
              onChange={(event) => setExpiry(event.target.value)}
              hint={t('client_keys.field_expiry_hint')}
            />
          </div>

          <fieldset className={styles.choices}>
            <legend>{t('client_keys.field_credentials')}</legend>
            {(['api-key', 'any'] as const).map((value) => (
              <label
                key={value}
                className={
                  credentials === value ? `${styles.choice} ${styles.choiceOn}` : styles.choice
                }
              >
                <input
                  type="radio"
                  name="client-key-credentials"
                  value={value}
                  checked={credentials === value}
                  onChange={() => setCredentials(value)}
                />
                <span className={styles.choiceText}>
                  <span className={styles.choiceTitle}>
                    {t(`client_keys.credentials_${value === 'any' ? 'any' : 'api_key'}_title`)}
                    <code>{value}</code>
                  </span>
                  <span className={styles.choiceHint}>
                    {t(`client_keys.credentials_${value === 'any' ? 'any' : 'api_key'}_hint`)}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}
          {/* Enter in a text field submits. */}
          <button type="submit" hidden />
        </fieldset>
      </form>
    </Modal>
  );
}
