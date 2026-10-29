import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { AutocompleteInput } from '@/components/ui/AutocompleteInput';
import { Button } from '@/components/ui/Button';
import type { UsageClientLabel } from '@/types';
import { maskApiKey } from '@/utils/format';
import { clientKind, type ClientRow } from '../usageModel';
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

  const devices = rows.filter((row) => clientKind(row) === 'device');
  const apps = rows.flatMap((row) => (row.appKey ? [{ row, appKey: row.appKey }] : []));
  const unknown = rows.filter((row) => clientKind(row) === 'unknown');

  const userField = (row: ClientRow) => {
    const userId = `usage-client-user-${row.fingerprint}`;
    return (
      <div className={styles.userField}>
        <label htmlFor={userId} className={styles.srOnly}>
          {t('usage.clients_user_label', { fingerprint: row.appKey?.name ?? row.fingerprint })}
        </label>
        <AutocompleteInput
          id={userId}
          value={valueOf(row).user}
          options={userOptions}
          placeholder={t('usage.unassigned')}
          disabled={disabled || saving}
          wrapperClassName={styles.autocomplete}
          className={styles.input}
          onChange={(user) => edit(row, { user })}
        />
      </div>
    );
  };

  // Device and unrecognized keys: a fingerprint, a device name and a user.
  const keyRow = (row: ClientRow) => (
    <li key={row.fingerprint} className={styles.row}>
      <div className={styles.identity}>
        <code className={styles.fingerprint}>{row.fingerprint}</code>
        <span className={row.apiKey ? styles.keyHint : styles.keyMissing}>
          {row.apiKey ? maskApiKey(row.apiKey) : t('usage.clients_key_unknown')}
        </span>
      </div>
      <input
        className={`input ${styles.input}`}
        value={valueOf(row).device}
        placeholder={t('usage.clients_device_placeholder')}
        aria-label={t('usage.clients_device_label', { fingerprint: row.fingerprint })}
        disabled={disabled || saving}
        onChange={(event) => edit(row, { device: event.target.value })}
      />
      {userField(row)}
    </li>
  );

  return (
    <div className={styles.editor}>
      {devices.length > 0 && (
        <>
          <div className={styles.head} aria-hidden="true">
            <span>{t('usage.clients_key')}</span>
            <span>{t('usage.clients_device')}</span>
            <span>{t('usage.clients_user')}</span>
          </div>
          <ul className={styles.rows}>{devices.map(keyRow)}</ul>
        </>
      )}

      {apps.length > 0 && (
        <section className={styles.group} aria-labelledby="usage-app-keys-title">
          <header className={styles.groupHead}>
            <h3 id="usage-app-keys-title" className={styles.groupTitle}>
              {t('usage.clients_apps_title')}
              <span className={styles.groupCount}>{apps.length}</span>
            </h3>
            <p className={styles.groupHint}>
              {t('usage.clients_apps_hint')}{' '}
              <Link to="/client-keys" className={styles.groupLink}>
                {t('usage.clients_apps_manage')}
              </Link>
            </p>
          </header>
          <ul className={styles.rows}>
            {apps.map(({ row, appKey }) => (
              <li key={row.fingerprint} className={`${styles.row} ${styles.appRow}`}>
                <div className={styles.appIdentity}>
                  <span className={styles.appName}>{appKey.name}</span>
                  <span className={styles.appMeta}>
                    {appKey.project && <span className={styles.chip}>{appKey.project}</span>}
                    {appKey.disabled && (
                      <span className={styles.chip}>{t('usage.clients_app_disabled')}</span>
                    )}
                    <code className={styles.keyHint}>
                      {row.fingerprint} · {appKey.prefix}
                    </code>
                  </span>
                </div>
                {userField(row)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {unknown.length > 0 && (
        <details className={styles.group}>
          <summary className={styles.groupSummary}>
            {t('usage.clients_unknown_title', { count: unknown.length })}
          </summary>
          <p className={styles.groupHint}>{t('usage.clients_unknown_hint')}</p>
          <ul className={styles.rows}>{unknown.map(keyRow)}</ul>
        </details>
      )}

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
