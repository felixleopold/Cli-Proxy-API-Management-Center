import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { useAuthStore } from '@/stores/useAuthStore';
import { useNotificationStore } from '@/stores';
import { apiClient } from '@/services/api/client';
import {
  readClaudeResetGrants,
  type AnthropicResetClaimAnswer,
  type AnthropicResetGrant,
  type AnthropicResetGrantStatus,
} from '@/services/api/claudeResetGrants';
import type { AuthFileItem } from '@/types';
import { normalizeAuthIndex } from '@/utils/quota';
import { resetGrantOperations, RETRY_WINDOW_MS } from './resetGrantOperations';
import { resetGrantBlock } from './resetGrantInfo';
import { selectResetGrant } from './selectResetGrant';
import { useResetGrantText } from './useResetGrantText';

/** Card-owned reads; the session-scoped journal owns spending and ambiguous retries. */
export function useClaudeResetGrants(
  file: AuthFileItem,
  enabled: boolean,
  disabled: boolean,
  refreshToken: unknown,
  onRefresh: () => void
) {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const [session] = useState(() => apiClient.getConnectionRevision());
  const sessionActive =
    connectionStatus === 'connected' && session === apiClient.getConnectionRevision();
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const now = useNow();
  const text = useResetGrantText(now);
  const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  const key = JSON.stringify([file.name, authIndex]);
  const [status, setStatus] = useState<AnthropicResetGrantStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState('');
  const [reload, setReload] = useState(0);
  const lock = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const version = ++generation.current;
    setStatus(null);
    if (!enabled || disabled || !sessionActive || !authIndex) return;
    let cancelled = false;
    const current = () =>
      !cancelled && version === generation.current && session === apiClient.getConnectionRevision();
    void readClaudeResetGrants(authIndex).then(
      (result) => {
        if (current()) {
          setStatus(result);
          setMessage('');
        }
      },
      () => {
        if (current()) setMessage('read_error');
      }
    );
    return () => {
      cancelled = true;
      generation.current += 1;
    };
  }, [authIndex, key, enabled, disabled, sessionActive, session, refreshToken, reload]);

  const operation = resetGrantOperations.inspect(key);
  const pending = operation && !operation.code ? operation : undefined;
  const expired = Boolean(pending && now - pending.createdAt >= RETRY_WINDOW_MS);
  const recommended = pending?.grantId ?? (status ? selectResetGrant(status, now)?.id : undefined);
  const locked = disabled || !sessionActive || !authIndex || busy || expired;

  /** Why a grant cannot be redeemed from the panel, or null. One claim per account at a time. */
  const grantBlocker = (grant: AnthropicResetGrant) => {
    if (pending) return pending.grantId === grant.id ? null : t('claude_reset.block.pending');
    const block = status ? resetGrantBlock(status, grant, now) : null;
    return block ? text.block(block) : null;
  };

  // Hover text for the row button, so a disabled button says why.
  const firstGrant =
    status?.grants.find((grant) => grant.id === status.nextGrantId && grant.resetsLeft > 0) ??
    status?.grants.find((grant) => grant.resetsLeft > 0);
  const buttonReason = recommended
    ? null
    : status
      ? firstGrant
        ? grantBlocker(firstGrant)
        : t('claude_reset.empty')
      : null;

  const describeAnswer = (answer: AnthropicResetClaimAnswer & { unresolved: boolean }) =>
    [
      t(`claude_reset.${answer.unresolved ? 'unknown' : answer.code}`),
      answer.cleared.length > 0 &&
        t('claude_reset.result_cleared', { windows: text.windows(answer.cleared) }),
      answer.resetsLeft !== null && t('claude_reset.result_left', { count: answer.resetsLeft }),
      answer.reason && t('claude_reset.result_reason', { reason: answer.reason }),
    ]
      .filter(Boolean)
      .join(' ');

  const confirm = (grantId = recommended) => {
    if (locked || lock.current || !grantId || !authIndex) return;
    const grant = status?.grants.find((item) => item.id === grantId);
    // Never offer a claim the panel believes is blocked; the journal re-checks before sending.
    if (pending ? pending.grantId !== grantId : !grant || grantBlocker(grant)) return;
    const version = generation.current;
    const current = () =>
      session === apiClient.getConnectionRevision() && version === generation.current;
    showConfirmation({
      title: t('claude_reset.redeem_title'),
      message: (
        <>
          <p>
            {t(pending ? 'claude_reset.retry_confirm' : 'claude_reset.confirm_text', {
              name: file.name,
            })}
          </p>
          <ul>
            <li>{t('claude_reset.confirm_account', { name: file.name })}</li>
            {grant && (
              <>
                <li>{t('claude_reset.confirm_kind', { kind: text.kind(grant) })}</li>
                <li>{text.givesBack(grant)}</li>
                <li>
                  {t('claude_reset.confirm_left', {
                    before: grant.resetsLeft,
                    after: Math.max(grant.resetsLeft - 1, 0),
                  })}
                </li>
              </>
            )}
          </ul>
        </>
      ),
      confirmText: t(pending ? 'claude_reset.retry' : 'claude_reset.confirm'),
      variant: 'primary',
      onConfirm: async () => {
        if (!current() || lock.current || useAuthStore.getState().connectionStatus !== 'connected')
          return;
        lock.current = true;
        setBusy(true);
        try {
          const answer = await resetGrantOperations.run(key, authIndex, grantId);
          if (!current()) return;
          const summary = describeAnswer(answer);
          setResult(summary);
          showNotification(
            summary,
            !answer.unresolved && (answer.code === 'reset' || answer.code === 'already_used')
              ? 'success'
              : 'error'
          );
        } catch {
          if (!current()) return;
          const unresolved = resetGrantOperations.inspect(key);
          const summary = t(
            `claude_reset.${unresolved && !unresolved.code ? 'unknown' : 'blocked'}`
          );
          setResult(summary);
          showNotification(summary, 'error');
        } finally {
          lock.current = false;
          // A concurrent page-wide refresh can invalidate this read generation.
          // Release the local lock regardless, but never refresh a replacement account.
          setBusy(false);
          setReload((value) => value + 1);
          if (current()) onRefresh();
        }
      },
    });
  };
  return {
    count: status?.grants.reduce((sum, grant) => sum + grant.resetsLeft, 0) ?? null,
    grants: status?.grants ?? [],
    busy,
    locked,
    blocked: locked || !recommended,
    confirm,
    grantBlocker,
    pendingGrantId: pending?.grantId ?? null,
    message: pending ? (expired ? 'expired' : 'unknown') : message,
    result,
    buttonLabel: pending ? 'retry' : 'use',
    buttonReason,
  };
}
