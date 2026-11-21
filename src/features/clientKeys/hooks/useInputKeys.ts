import { useCallback, useEffect, useRef, useState } from 'react';
import { inputKeysApi, type InputKey } from '@/services/api/inputKeys';
import { getErrorMessage } from '@/utils/helpers';

export interface InputKeysState {
  keys: InputKey[];
  /** Only until the first response; reloads keep the current list visible. */
  loading: boolean;
  error: string;
}

/** Upstream API-key credentials; older responses never win. */
export function useInputKeys() {
  const [state, setState] = useState<InputKeysState>({ keys: [], loading: true, error: '' });
  const requestRef = useRef(0);

  const reload = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const keys = await inputKeysApi.list();
      if (request === requestRef.current) setState({ keys, loading: false, error: '' });
    } catch (err: unknown) {
      if (request === requestRef.current)
        setState((prev) => ({ ...prev, loading: false, error: getErrorMessage(err) }));
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => {
      requestRef.current += 1;
    };
  }, [reload]);

  return { ...state, reload };
}
