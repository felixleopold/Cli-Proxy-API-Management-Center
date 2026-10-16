import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AutocompleteInput } from '@/components/ui/AutocompleteInput';
import { Button } from '@/components/ui/Button';
import type { UsageClientLabel } from '@/types';
import { maskApiKey } from '@/utils/format';
import type { ClientRow } from '../usageModel';
import styles from './UsageClientsEditor.module.scss';

interface UsageClientsEditorProps {
  rows: ClientRow[];
  disabled: boolean;
  onSave: (labels: UsageClientLabel[]) => Promise<void>;
}

type Draft = Pick<ClientRow, 'device' | 'user'>;

export function UsageClientsEditor({ rows, disabled, onSave }: UsageClientsEditorProps) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState(false);

  const valueOf = (row: ClientRow): Draft => drafts[row.fingerprint] ?? row;

  const dirtyCount = rows.filter((row) => {
    const draft = drafts[row.fingerprint];
    return draft && (draft.device.trim() !== row.device || draft.user.trim() !== row.user);
  }).length;

  const userOptions = useMemo(
    () =>
      Array.from(
        new Set(
          [...rows, ...Object.values(drafts)].map((value) => value.user.trim()).filter(Boolean)
        )
      ).sort((a, b) => a.localeCompare(b)),
    [rows, drafts]
  );

  const edit = (row: ClientRow, patch: Partial<Draft>) =>
    setDrafts((prev) => ({ ...prev, [row.fingerprint]: { ...valueOf(row), ...patch } }));

  const handleSave = async () => {
    // Labelled rows, plus previously labelled ones so clearing a label is saved too.
    const labels = rows
      .map((row) => {
        const value = valueOf(row);
        return { row, device: value.device.trim(), user: value.user.trim() };
      })
      .filter(({ row, device, user }) => device || user || row.device || row.user)
      .map(({ row, device, user }) => ({ fingerprint: row.fingerprint, device, user }));
    setSaving(true);
    try {
      await onSave(labels);
      setDrafts({});
    } finally {
      setSaving(false);
    }
  };

  if (rows.length === 0) {
    return <p className={styles.empty}>{t('usage.clients_empty')}</p>;
  }

  return (
    <div className={styles.editor}>
      <div className={styles.head} aria-hidden="true">
        <span>{t('usage.clients_key')}</span>
        <span>{t('usage.clients_device')}</span>
        <span>{t('usage.clients_user')}</span>
      </div>
      <ul className={styles.rows}>
        {rows.map((row) => {
          const value = valueOf(row);
          const userId = `usage-client-user-${row.fingerprint}`;
          return (
            <li key={row.fingerprint} className={styles.row}>
              <div className={styles.identity}>
                <code className={styles.fingerprint}>{row.fingerprint}</code>
                <span className={row.apiKey ? styles.keyHint : styles.keyMissing}>
                  {row.apiKey ? maskApiKey(row.apiKey) : t('usage.clients_key_unknown')}
                </span>
              </div>
              <input
                className={`input ${styles.input}`}
                value={value.device}
                placeholder={t('usage.clients_device_placeholder')}
                aria-label={t('usage.clients_device_label', { fingerprint: row.fingerprint })}
                disabled={disabled || saving}
                onChange={(event) => edit(row, { device: event.target.value })}
              />
              <div className={styles.userField}>
                <label htmlFor={userId} className={styles.srOnly}>
                  {t('usage.clients_user_label', { fingerprint: row.fingerprint })}
                </label>
                <AutocompleteInput
                  id={userId}
                  value={value.user}
                  options={userOptions}
                  placeholder={t('usage.unassigned')}
                  disabled={disabled || saving}
                  wrapperClassName={styles.autocomplete}
                  className={styles.input}
                  onChange={(user) => edit(row, { user })}
                />
              </div>
            </li>
          );
        })}
      </ul>
      <div className={styles.footer}>
        <span className={styles.dirty} role="status">
          {dirtyCount > 0 ? t('usage.clients_unsaved', { count: dirtyCount }) : ''}
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={dirtyCount === 0 || saving}
          onClick={() => setDrafts({})}
        >
          {t('usage.clients_discard')}
        </Button>
        <Button
          size="sm"
          disabled={disabled || saving || dirtyCount === 0}
          onClick={() => void handleSave()}
        >
          {saving ? t('usage.clients_saving') : t('usage.clients_save')}
        </Button>
      </div>
    </div>
  );
}
