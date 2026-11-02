import { useEffect, useState } from 'react';
import { usageLedgerApi } from '@/services/api';
import { useAuthStore } from '@/stores';

/**
 * The user labels of the gateway's usage-ledger clients (`usage-ledger.clients`),
 * distinct and sorted. Usage reserves name people by these labels. Empty while
 * loading, disconnected, or when the ledger is off.
 */
export function useLedgerUsers(): string[] {
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const [users, setUsers] = useState<string[]>([]);

  useEffect(() => {
    if (!connected) return;
    let current = true;
    usageLedgerApi
      .getClients()
      .then((clients) => {
        if (!current) return;
        const names = new Map<string, string>();
        for (const { user } of clients) {
          if (user && !names.has(user.toLowerCase())) names.set(user.toLowerCase(), user);
        }
        setUsers([...names.values()].sort((a, b) => a.localeCompare(b)));
      })
      .catch(() => {
        // Without the ledger there are no labels to suggest; names can still be typed.
      });
    return () => {
      current = false;
    };
  }, [connected]);

  return connected ? users : [];
}
