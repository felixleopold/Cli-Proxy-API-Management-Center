/**
 * Client keys page: per-app gateway keys with a monthly budget, a model allowlist and a
 * credential pin, plus the agent (manager) tokens that may administer them.
 *
 * The page is a header, an overview and a list of sections; each section is a `Section` with
 * its own component, so a new panel is one more entry below. Secrets returned by create and
 * rotate live only in `revealed`, which is dropped when the reveal dialog closes.
 */

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { IconPlus } from '@/components/ui/icons';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import {
  clientKeysApi,
  type ClientKey,
  type ClientKeyInput,
  type ClientKeyManager,
} from '@/services/api/clientKeys';
import { useAuthStore, useNotificationStore } from '@/stores';
import { getErrorMessage } from '@/utils/helpers';
import { projectsOf, summarizeKeys } from './clientKeysModel';
import { AgentTokens } from './components/AgentTokens';
import { KeyDetailSheet } from './components/KeyDetailSheet';
import { KeyFormDialog } from './components/KeyFormDialog';
import { KeysList } from './components/KeysList';
import { Overview } from './components/Overview';
import { SecretReveal, type RevealedSecret } from './components/SecretReveal';
import { Section } from './components/Section';
import { useClientKeys } from './hooks/useClientKeys';
import { readViewPrefs, writeViewPrefs, type ClientKeysViewPrefs } from './viewPrefs';
import styles from './ClientKeysPage.module.scss';

/** The key form: closed, creating, or editing one key. */
type FormState = { mode: 'closed' } | { mode: 'create' } | { mode: 'edit'; key: ClientKey };

export function ClientKeysPage() {
  const { t } = useTranslation();
  const nowMs = useNow();
  const gatewayOrigin = useAuthStore((state) => state.apiBase);
  const showNotification = useNotificationStore((store) => store.showNotification);
  const showConfirmation = useNotificationStore((store) => store.showConfirmation);
  const { keys, managers, loading, featureOff, error, reload } = useClientKeys();

  const [prefs, setPrefs] = useState<ClientKeysViewPrefs>(readViewPrefs);
  const [form, setForm] = useState<FormState>({ mode: 'closed' });
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [creatingToken, setCreatingToken] = useState(false);

  useHeaderRefresh(reload);

  const overview = useMemo(() => summarizeKeys(keys, nowMs), [keys, nowMs]);
  const projects = useMemo(() => projectsOf(keys), [keys]);
  const detailKey = keys.find((key) => key.id === detailId) ?? null;
  const ledgerOff = keys.length > 0 && overview.spentUsd === null;

  const changePrefs = useCallback((next: ClientKeysViewPrefs) => {
    setPrefs(next);
    writeViewPrefs(next);
  }, []);

  const fail = (err: unknown) =>
    showNotification(getErrorMessage(err, t('common.unknown_error')), 'error');

  const submitForm = async (input: ClientKeyInput) => {
    if (form.mode === 'edit') {
      await clientKeysApi.update(form.key.id, input);
      setForm({ mode: 'closed' });
      showNotification(t('client_keys.saved', { name: input.name }), 'success');
    } else {
      const { key, secret } = await clientKeysApi.create(input);
      setForm({ mode: 'closed' });
      setRevealed({ kind: 'created', name: key.name, secret });
    }
    void reload();
  };

  const rotate = (key: ClientKey) =>
    showConfirmation({
      title: t('client_keys.rotate_confirm_title', { name: key.name }),
      message: t('client_keys.rotate_confirm_message'),
      confirmText: t('client_keys.rotate_confirm_button'),
      variant: 'primary',
      onConfirm: async () => {
        try {
          const { secret } = await clientKeysApi.rotate(key.id);
          setRevealed({ kind: 'rotated', name: key.name, secret });
          void reload();
        } catch (err: unknown) {
          fail(err);
        }
      },
    });

  const toggleDisabled = async (key: ClientKey) => {
    setPendingId(key.id);
    try {
      await clientKeysApi.setDisabled(key.id, !key.disabled);
      showNotification(
        t(key.disabled ? 'client_keys.enabled_notice' : 'client_keys.disabled_notice', {
          name: key.name,
        }),
        'success'
      );
      await reload();
    } catch (err: unknown) {
      fail(err);
    } finally {
      setPendingId(null);
    }
  };

  const revoke = (key: ClientKey) =>
    showConfirmation({
      title: t('client_keys.revoke_confirm_title', { name: key.name }),
      message: t('client_keys.revoke_confirm_message'),
      confirmText: t('client_keys.revoke_confirm_button'),
      variant: 'danger',
      onConfirm: async () => {
        try {
          await clientKeysApi.revoke(key.id);
          if (detailId === key.id) setDetailId(null);
          showNotification(t('client_keys.revoked_notice', { name: key.name }), 'success');
          void reload();
        } catch (err: unknown) {
          fail(err);
        }
      },
    });

  const createToken = async (name: string) => {
    const { manager, token } = await clientKeysApi.createManager(name);
    setCreatingToken(false);
    setRevealed({ kind: 'token', name: manager.name, secret: token });
    void reload();
  };

  const revokeToken = (manager: ClientKeyManager) =>
    showConfirmation({
      title: t('client_keys.tokens_revoke_title', { name: manager.name }),
      message: t('client_keys.tokens_revoke_message'),
      confirmText: t('client_keys.tokens_revoke'),
      variant: 'danger',
      onConfirm: async () => {
        try {
          await clientKeysApi.revokeManager(manager.id);
          void reload();
        } catch (err: unknown) {
          fail(err);
        }
      },
    });

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <h1 className={styles.title}>{t('client_keys.page_title')}</h1>
          {!featureOff && (
            <p className={styles.meta}>
              <span>{t('client_keys.meta_keys', { count: keys.length })}</span>
              <span className={styles.metaDot} aria-hidden="true">
                ·
              </span>
              <span>{t('client_keys.meta_projects', { count: projects.length })}</span>
              <span className={styles.metaDot} aria-hidden="true">
                ·
              </span>
              <span>{t('client_keys.meta_tokens', { count: managers.length })}</span>
            </p>
          )}
        </div>
        {!featureOff && (
          <button
            type="button"
            className={styles.primaryAction}
            onClick={() => setForm({ mode: 'create' })}
            disabled={loading}
          >
            <IconPlus size={14} />
            {t('client_keys.new_key')}
          </button>
        )}
      </header>

      {error && (
        <div className={styles.errorBanner} role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <div className={styles.skeletons} aria-hidden="true">
          <Skeleton height={92} rounded={14} />
          <Skeleton height={320} rounded={14} />
        </div>
      ) : featureOff ? (
        <section className={styles.off} aria-labelledby="client-keys-off-title">
          <h2 id="client-keys-off-title" className={styles.offTitle}>
            {t('client_keys.off_title')}
          </h2>
          <p className={styles.offText}>{t('client_keys.off_text')}</p>
          <pre className={styles.offCode}>{CONFIG_SNIPPET}</pre>
          <p className={styles.offNote}>{t('client_keys.off_note')}</p>
        </section>
      ) : (
        <>
          <Overview overview={overview} />

          {ledgerOff && (
            <p className={styles.notice} role="note">
              {t('client_keys.ledger_off_notice')}
            </p>
          )}

          <Section title={t('client_keys.keys_title')} hint={t('client_keys.keys_hint')}>
            <KeysList
              keys={keys}
              nowMs={nowMs}
              prefs={prefs}
              onPrefsChange={changePrefs}
              pendingId={pendingId}
              onCreate={() => setForm({ mode: 'create' })}
              onOpen={(key) => setDetailId(key.id)}
              onEdit={(key) => setForm({ mode: 'edit', key })}
              onRotate={rotate}
              onToggleDisabled={(key) => void toggleDisabled(key)}
              onRevoke={revoke}
            />
          </Section>

          <Section
            title={t('client_keys.tokens_title')}
            hint={t('client_keys.tokens_hint')}
            actions={
              <Button
                variant="secondary"
                size="sm"
                className={styles.iconButton}
                onClick={() => setCreatingToken(true)}
              >
                <IconPlus size={14} />
                {t('client_keys.tokens_new')}
              </Button>
            }
          >
            <AgentTokens
              managers={managers}
              creating={creatingToken}
              onCreatingChange={setCreatingToken}
              onCreate={createToken}
              onRevoke={revokeToken}
            />
          </Section>
        </>
      )}

      {form.mode !== 'closed' && (
        <KeyFormDialog
          editing={form.mode === 'edit' ? form.key : null}
          projects={projects}
          onClose={() => setForm({ mode: 'closed' })}
          onSubmit={submitForm}
        />
      )}

      {detailKey && (
        <KeyDetailSheet keyEntry={detailKey} nowMs={nowMs} onClose={() => setDetailId(null)} />
      )}

      {revealed && (
        <SecretReveal
          revealed={revealed}
          gatewayOrigin={gatewayOrigin}
          onClose={() => setRevealed(null)}
        />
      )}
    </div>
  );
}

const CONFIG_SNIPPET = `client-keys:
  enabled: true
usage-ledger:
  enabled: true   # budgets and spend`;
