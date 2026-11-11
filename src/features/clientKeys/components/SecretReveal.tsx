import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { IconAlertTriangle, IconCheck, IconCopy } from '@/components/ui/icons';
import { useConfigStore } from '@/stores';
import { copyToClipboard } from '@/utils/clipboard';
import { alternativeGatewayUrls, anthropicEnvSnippet, openAiBaseUrl } from '../clientKeysModel';
import { readGatewayUrl, writeGatewayUrl } from '../viewPrefs';
import styles from './SecretReveal.module.scss';

/**
 * A secret the gateway returns once: a new or rotated client key, or a new agent token.
 * The page holds it only while this dialog is open and drops it on close.
 */
export interface RevealedSecret {
  kind: 'created' | 'rotated' | 'token';
  name: string;
  secret: string;
}

interface SecretRevealProps {
  revealed: RevealedSecret;
  /** The panel's API base; the gateway URL field starts from it until one is saved. */
  gatewayOrigin: string;
  onClose: () => void;
}

const COPIED_MS = 2000;

function CopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      variant="secondary"
      size="sm"
      className={styles.copy}
      aria-label={label}
      onClick={() => void copyToClipboard(text).then(setCopied)}
    >
      {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      {copied ? t('client_keys.copied') : t('client_keys.copy')}
    </Button>
  );
}

export function SecretReveal({ revealed, gatewayOrigin, onClose }: SecretRevealProps) {
  const { t } = useTranslation();
  const isKey = revealed.kind !== 'token';
  const gatewayId = useId();
  const [gatewayUrl, setGatewayUrl] = useState(() => readGatewayUrl() ?? gatewayOrigin);
  const configuredUrls = useConfigStore((state) => state.config?.clientKeysGatewayUrls);
  const fetchConfig = useConfigStore((state) => state.fetchConfig);
  const alternatives = alternativeGatewayUrls(configuredUrls ?? [], gatewayUrl);
  const openAiBase = openAiBaseUrl(gatewayUrl);
  const snippet = isKey ? anthropicEnvSnippet(gatewayUrl.trim(), revealed.secret) : '';

  useEffect(() => {
    if (isKey) void fetchConfig().catch(() => undefined);
  }, [isKey, fetchConfig]);

  const changeGatewayUrl = (value: string) => {
    setGatewayUrl(value);
    writeGatewayUrl(value.trim());
  };

  return (
    <Modal
      open
      onClose={onClose}
      width={640}
      title={t(`client_keys.reveal_title_${revealed.kind}`, { name: revealed.name })}
      footer={<Button onClick={onClose}>{t('client_keys.reveal_done')}</Button>}
    >
      <div className={styles.body}>
        <p className={styles.warning} role="note">
          <IconAlertTriangle size={16} />
          <span>
            {t(isKey ? 'client_keys.reveal_warning' : 'client_keys.reveal_warning_token')}
            {revealed.kind === 'rotated' && ` ${t('client_keys.reveal_rotated_note')}`}
          </span>
        </p>

        <div className={styles.block}>
          <div className={styles.blockHead}>
            <span className={styles.blockLabel}>
              {t(isKey ? 'client_keys.reveal_secret_label' : 'client_keys.reveal_token_label')}
            </span>
            <CopyButton text={revealed.secret} label={t('client_keys.copy_secret')} />
          </div>
          <code className={styles.secret}>{revealed.secret}</code>
        </div>

        {isKey && (
          <div className={styles.block}>
            <label htmlFor={gatewayId} className={styles.blockLabel}>
              {t('client_keys.reveal_gateway_label')}
            </label>
            <input
              id={gatewayId}
              className="input"
              value={gatewayUrl}
              onChange={(event) => changeGatewayUrl(event.target.value)}
              placeholder="http://127.0.0.1:8317"
              spellCheck={false}
              autoComplete="off"
              aria-describedby={`${gatewayId}-hint`}
            />
            {alternatives.length > 0 && (
              <div className={styles.alternatives}>
                {alternatives.map((url) => (
                  <Button
                    key={url}
                    variant="secondary"
                    size="sm"
                    onClick={() => changeGatewayUrl(url)}
                  >
                    {t('client_keys.reveal_gateway_use', { url })}
                  </Button>
                ))}
              </div>
            )}
            <p id={`${gatewayId}-hint`} className={styles.hint}>
              {t('client_keys.reveal_gateway_hint')}
              {alternatives.length > 0 && ` ${t('client_keys.reveal_gateway_alternatives_hint')}`}
            </p>
          </div>
        )}

        {isKey && (
          <div className={styles.block}>
            <div className={styles.blockHead}>
              <span className={styles.blockLabel}>{t('client_keys.reveal_env_label')}</span>
              <CopyButton text={snippet} label={t('client_keys.copy_env')} />
            </div>
            <pre className={styles.snippet}>{snippet}</pre>
            <p className={styles.hint}>{t('client_keys.reveal_env_hint')}</p>
          </div>
        )}

        {isKey && (
          <div className={styles.block}>
            <div className={styles.blockHead}>
              <span className={styles.blockLabel}>{t('client_keys.reveal_openai_label')}</span>
              <CopyButton text={openAiBase} label={t('client_keys.copy_openai_base')} />
            </div>
            <code className={styles.secret}>{openAiBase}</code>
            <p className={styles.hint}>{t('client_keys.reveal_openai_hint')}</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
