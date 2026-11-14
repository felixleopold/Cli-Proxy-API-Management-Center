/**
 * A Claude row's Fable lock: while on, the gateway sends every Fable request to
 * this account and no other. One account holds it at a time, so locking one
 * moves the lock. PUT /usage/fable {name} locks, DELETE /usage/fable clears;
 * the listing's `fable_locked` shows it. A success patches the list as the
 * gateway does (one holder, see applyFilePatch); after any attempt the listing
 * reloads, and the button stays busy until it has.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconLock } from '@/components/ui/icons';
import { usagePoolApi } from '@/services/api/usagePool';
import { useNotificationStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import styles from './Accounts.module.scss';

export function FableLockControl({
  file,
  onChange,
  onReload,
}: {
  file: AuthFileItem;
  /** Patches the listed credentials; a lock change also clears every other holder. */
  onChange: (patch: Pick<AuthFileItem, 'fableLocked'>) => void;
  /** Refetches the listing, the source of truth for who holds the lock. */
  onReload: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [busy, setBusy] = useState(false);
  const locked = file.fableLocked === true;
  const name = file.nickname || file.email || file.name;

  const toggle = async () => {
    setBusy(true);
    try {
      if (locked) await usagePoolApi.clearFableLock();
      else await usagePoolApi.lockFable(file.name);
      onChange({ fableLocked: !locked || undefined });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('common.unknown_error');
      showNotification(t('fable_lock.failed', { message }), 'error');
    } finally {
      await onReload();
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className={`${styles.iconButton} ${styles.paceButton}`}
      data-pace="fable"
      data-active={locked || undefined}
      aria-pressed={locked}
      aria-label={t(locked ? 'fable_lock.unlock' : 'fable_lock.lock', { name })}
      title={t(locked ? 'fable_lock.locked_title' : 'fable_lock.title')}
      disabled={busy}
      onClick={() => void toggle()}
      data-row-control
    >
      <IconLock size={13} aria-hidden="true" />
    </button>
  );
}
