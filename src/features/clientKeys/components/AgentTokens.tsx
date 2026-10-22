import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { IconBot, IconTrash2 } from '@/components/ui/icons';
import type { ClientKeyManager } from '@/services/api/clientKeys';
import { getErrorMessage } from '@/utils/helpers';
import styles from './AgentTokens.module.scss';

interface AgentTokensProps {
  managers: ClientKeyManager[];
  creating: boolean;
  onCreatingChange: (open: boolean) => void;
  /** Rejects with the gateway's message, shown in the dialog. */
  onCreate: (name: string) => Promise<void>;
  onRevoke: (manager: ClientKeyManager) => void;
}

/** Manager tokens: agents that may manage client keys and nothing else. */
export function AgentTokens({
  managers,
  creating,
  onCreatingChange,
  onCreate,
  onRevoke,
}: AgentTokensProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;

  return (
    <>
      {managers.length === 0 ? (
        <p className={styles.empty}>{t('client_keys.tokens_empty')}</p>
      ) : (
        <ul className={styles.list}>
          {managers.map((manager) => (
            <li key={manager.id} className={styles.item}>
              <span className={styles.icon} aria-hidden="true">
                <IconBot size={16} />
              </span>
              <span className={styles.copy}>
                <span className={styles.name}>{manager.name || manager.id}</span>
                <span className={styles.meta}>
                  <code>cpm-…{manager.hint}</code>
                  <span aria-hidden="true">·</span>
                  {t('client_keys.tokens_created', {
                    date: new Date(manager.createdAtMs).toLocaleDateString(locale, {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                    }),
                  })}
                </span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                className={styles.revoke}
                onClick={() => onRevoke(manager)}
                aria-label={t('client_keys.tokens_revoke_label', { name: manager.name })}
              >
                <IconTrash2 size={14} />
                {t('client_keys.tokens_revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {creating && (
        <CreateTokenDialog onClose={() => onCreatingChange(false)} onCreate={onCreate} />
      )}
    </>
  );
}

function CreateTokenDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Blocks a second submit before `saving` re-renders; each create mints a token.
  const inFlightRef = useRef(false);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (inFlightRef.current) return;
    if (!name.trim()) {
      setError(t('client_keys.field_name_required'));
      return;
    }
    inFlightRef.current = true;
    setSaving(true);
    setError('');
    try {
      await onCreate(name.trim());
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
      title={t('client_keys.tokens_create_title')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving ? t('client_keys.form_saving') : t('client_keys.tokens_create')}
          </Button>
        </>
      }
    >
      <form onSubmit={(event) => void submit(event)}>
        <p className={styles.dialogHint}>{t('client_keys.tokens_hint')}</p>
        <Input
          label={t('client_keys.field_name')}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('client_keys.tokens_name_placeholder')}
          error={error || undefined}
          disabled={saving}
          autoFocus
        />
      </form>
    </Modal>
  );
}
