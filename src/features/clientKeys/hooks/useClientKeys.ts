import { useCallback, useEffect, useRef, useState } from 'react';
import { clientKeysApi, type ClientKey, type ClientKeyManager } from '@/services/api/clientKeys';
import { getErrorMessage } from '@/utils/helpers';

export interface ClientKeysState {
  keys: ClientKey[];
  managers: ClientKeyManager[];
  /** Only until the first response; reloads keep the current list visible. */
  loading: boolean;
  /** `client-keys.enabled` is off (409). */
  featureOff: boolean;
  error: string;
}

const INITIAL: ClientKeysState = {
  keys: [],
  managers: [],
  loading: true,
  featureOff: false,
  error: '',
};

const statusOf = (reason: unknown) => (reason as { status?: number } | null)?.status;

/** Keys and manager tokens, reloaded after every change; older responses never win. */
export function useClientKeys() {
  const [state, setState] = useState<ClientKeysState>(INITIAL);
  const requestRef = useRef(0);

  const reload = useCallback(async () => {
    const request = ++requestRef.current;
    const [keys, managers] = await Promise.allSettled([
      clientKeysApi.list(),
      clientKeysApi.listManagers(),
    ]);
    if (request !== requestRef.current) return;
    if (keys.status === 'rejected') {
      const featureOff = statusOf(keys.reason) === 409;
      setState({
        ...INITIAL,
        loading: false,
        featureOff,
        error: featureOff ? '' : getErrorMessage(keys.reason),
      });
      return;
    }
    setState({
      keys: keys.value,
      managers: managers.status === 'fulfilled' ? managers.value : [],
      loading: false,
      featureOff: false,
      error: managers.status === 'rejected' ? getErrorMessage(managers.reason) : '',
    });
  }, []);

  useEffect(() => {
    void reload();
    return () => {
      requestRef.current += 1;
    };
  }, [reload]);

  return { ...state, reload };
}
