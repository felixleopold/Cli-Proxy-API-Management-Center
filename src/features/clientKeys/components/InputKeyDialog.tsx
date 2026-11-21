import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import type { InputKey, InputKeySettings } from '@/services/api/inputKeys';
import { getErrorMessage } from '@/utils/helpers';
import { groupChoices, inputKeyLabel, parseCycleDay, parseLimitUsd } from '../inputKeysModel';
import { GroupPicker } from './GroupPicker';
import formStyles from './KeyFormDialog.module.scss';
import styles from './InputKeyDialog.module.scss';

interface InputKeyDialogProps {
  entry: InputKey;
  /** Configured `credential-groups` names. */
  groups: string[];
  onClose: () => void;
  /** Rejects with the gateway's message, shown in the form. */
  onSubmit: (settings: InputKeySettings) => Promise<void>;
}

/** Edit one upstream key's spend cycle, limit, client-key scope and credential groups. */
export function InputKeyDialog({ entry, groups, onClose, onSubmit }: InputKeyDialogProps) {
  const { t } = useTranslation();
  const [day, setDay] = useState(String(entry.billingCycleDay));
  const [limit, setLimit] = useState(
    entry.monthlyLimitUsd > 0 ? String(entry.monthlyLimitUsd) : ''
  );
  const [clientKeysOnly, setClientKeysOnly] = useState(entry.clientKeysOnly);
  const [serveClientKeys, setServeClientKeys] = useState(entry.serveClientKeys);
  const [selected, setSelected] = useState<string[]>(entry.credentialGroups);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const inFlightRef = useRef(false);
  const [error, setError] = useState('');

  const dayValue = parseCycleDay(day);
  const limitValue = parseLimitUsd(limit);
  const choices = groupChoices(groups, entry.credentialGroups);

  const handleSubmit = async (event?: FormEvent) => {
    event?.preventDefault();
    setSubmitted(true);
    if (inFlightRef.current || dayValue === null || limitValue === null) return;
    inFlightRef.current = true;
    setSaving(true);
    setError('');
    try {
      await onSubmit({
        authId: entry.id,
        billingCycleDay: dayValue,
        monthlyLimitUsd: limitValue,
        clientKeysOnly,
        serveClientKeys: clientKeysOnly || serveClientKeys,
        // Config order, so an unchanged selection is sent unchanged.
        credentialGroups: choices.filter((group) => selected.includes(group)),
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
      width={560}
      title={t('input_keys.form_title', { name: inputKeyLabel(entry) })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={saving}>
            {saving ? t('client_keys.form_saving') : t('client_keys.form_save')}
          </Button>
        </>
      }
    >
      <form onSubmit={(event) => void handleSubmit(event)}>
        <fieldset className={formStyles.form} disabled={saving}>
          <p className={styles.subject}>
            <span>{entry.provider}</span>
            <code>{entry.id}</code>
          </p>

          <div className={formStyles.row}>
            <Input
              label={t('input_keys.field_cycle_day')}
              type="number"
              inputMode="numeric"
              min={1}
              max={31}
              step={1}
              value={day}
              onChange={(event) => setDay(event.target.value)}
              hint={t('input_keys.field_cycle_day_hint')}
              error={
                submitted && dayValue === null ? t('input_keys.field_cycle_day_invalid') : undefined
              }
              autoFocus
            />
            <Input
              label={t('input_keys.field_limit')}
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
              placeholder={t('input_keys.field_limit_placeholder')}
              hint={t('input_keys.field_limit_hint')}
              error={
                submitted && limitValue === null ? t('client_keys.field_budget_invalid') : undefined
              }
            />
          </div>

          <fieldset className={styles.group}>
            <legend>{t('input_keys.field_access')}</legend>
            <div className={styles.toggleRow}>
              <ToggleSwitch
                checked={clientKeysOnly}
                onChange={setClientKeysOnly}
                label={t('input_keys.scope_client_only')}
              />
              <span className={styles.toggleHint}>{t('input_keys.scope_client_only_hint')}</span>
            </div>
            <div className={styles.toggleRow}>
              <ToggleSwitch
                checked={clientKeysOnly || serveClientKeys}
                onChange={setServeClientKeys}
                disabled={clientKeysOnly}
                label={t('input_keys.field_serve')}
              />
              <span className={styles.toggleHint}>
                {clientKeysOnly
                  ? t('input_keys.field_serve_implied')
                  : t('input_keys.scope_shared_hint')}
              </span>
            </div>
          </fieldset>

          <fieldset className={styles.group}>
            <legend>{t('input_keys.field_groups')}</legend>
            {choices.length === 0 ? (
              <p className={styles.toggleHint}>{t('input_keys.no_groups')}</p>
            ) : (
              <GroupPicker
                mode="multi"
                choices={choices}
                configured={groups}
                selected={selected}
                onChange={setSelected}
                ariaLabel={t('input_keys.field_groups')}
              />
            )}
            <span className={styles.toggleHint}>{t('input_keys.field_groups_hint')}</span>
          </fieldset>

          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}
          <button type="submit" hidden />
        </fieldset>
      </form>
    </Modal>
  );
}
