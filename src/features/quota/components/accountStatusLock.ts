/**
 * Pending enabled-toggle requests per credential, held by the accounts list.
 * Toggling moves a row between the quota and disabled groups, which remounts
 * it, so a row-local flag would let a second request start while the first is
 * still in flight.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

export interface AccountStatusLock {
  isPending: (key: string) => boolean;
  /** Claims the credential; false when a request for it is already pending. */
  begin: (key: string) => boolean;
  end: (key: string) => void;
}

export const AccountStatusLockContext = createContext<AccountStatusLock | null>(null);

export function useAccountStatusLockState(): AccountStatusLock {
  const pendingRef = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const begin = useCallback((key: string) => {
    if (pendingRef.current.has(key)) return false;
    pendingRef.current.add(key);
    setPending(new Set(pendingRef.current));
    return true;
  }, []);
  const end = useCallback((key: string) => {
    pendingRef.current.delete(key);
    setPending(new Set(pendingRef.current));
  }, []);
  return useMemo(
    () => ({ isPending: (key) => pending.has(key), begin, end }),
    [pending, begin, end]
  );
}

export function useAccountStatusLock(): AccountStatusLock {
  const lock = useContext(AccountStatusLockContext);
  if (!lock) throw new Error('useAccountStatusLock needs AccountStatusLockContext');
  return lock;
}
