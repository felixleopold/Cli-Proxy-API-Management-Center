/**
 * Quota history: passive per-credential quota snapshots recorded by the backend
 * whenever a credential's snapshot changes.
 */

import { apiClient } from './client';
import { isRecord } from '@/utils/helpers';

export type QuotaHistoryWindow = 'weekly' | 'session';

export interface QuotaHistorySample {
  atMs: number;
  authId: string;
  provider: string;
  window: QuotaHistoryWindow;
  windowMinutes: number;
  /** 0..100 */
  usedPercent: number;
  resetAtMs: number;
}

export type QuotaHistoryResult =
  | { status: 'ok'; samples: QuotaHistorySample[] }
  /** The backend has history recording turned off (409). */
  | { status: 'disabled' };

const readMs = (value: unknown): number | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

const readNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Drops malformed samples instead of failing the whole response; result is sorted by time. */
export const normalizeQuotaHistorySamples = (payload: unknown): QuotaHistorySample[] => {
  const raw = isRecord(payload) && Array.isArray(payload.samples) ? payload.samples : [];
  const samples: QuotaHistorySample[] = [];
  raw.forEach((entry: unknown) => {
    if (!isRecord(entry)) return;
    const atMs = readMs(entry.at);
    const resetAtMs = readMs(entry.reset_at);
    const usedPercent = readNumber(entry.used_percent);
    const windowMinutes = readNumber(entry.window_minutes);
    const { auth_id: authId, provider, window } = entry;
    if (
      atMs === null ||
      resetAtMs === null ||
      usedPercent === null ||
      windowMinutes === null ||
      windowMinutes <= 0 ||
      typeof authId !== 'string' ||
      !authId ||
      typeof provider !== 'string' ||
      (window !== 'weekly' && window !== 'session')
    ) {
      return;
    }
    samples.push({
      atMs,
      authId,
      provider: provider.toLowerCase(),
      window,
      windowMinutes,
      usedPercent: Math.min(100, Math.max(0, usedPercent)),
      resetAtMs,
    });
  });
  return samples.sort((left, right) => left.atMs - right.atMs);
};

/** A private credential in the private history response, listed even without samples. */
export interface PrivateHistoryCredential {
  authId: string;
  label: string;
  provider: string;
  privateUser: string;
  disabled: boolean;
}

export type PrivateQuotaHistoryResult =
  | { status: 'ok'; samples: QuotaHistorySample[]; credentials: PrivateHistoryCredential[] }
  | { status: 'disabled' };

export const normalizePrivateHistoryCredentials = (
  payload: unknown
): PrivateHistoryCredential[] => {
  const raw = isRecord(payload) && Array.isArray(payload.credentials) ? payload.credentials : [];
  return raw.flatMap((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.auth_id !== 'string' || !entry.auth_id) return [];
    const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
    return [
      {
        authId: entry.auth_id,
        label: text(entry.label) || entry.auth_id,
        provider: text(entry.provider).toLowerCase(),
        privateUser: text(entry.private_user),
        disabled: entry.disabled === true,
      },
    ];
  });
};

const historyParams = (fromMs: number, toMs: number) => ({
  params: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
});

const isDisabled = (error: unknown) => isRecord(error) && error.status === 409;

export const quotaHistoryApi = {
  list: async (fromMs: number, toMs: number): Promise<QuotaHistoryResult> => {
    try {
      const payload = await apiClient.get<unknown>(
        '/observability/quota/history',
        historyParams(fromMs, toMs)
      );
      return { status: 'ok', samples: normalizeQuotaHistorySamples(payload) };
    } catch (error: unknown) {
      if (isDisabled(error)) return { status: 'disabled' };
      throw error;
    }
  },
  /** The private credentials' history, which the shared endpoint leaves out. */
  listPrivate: async (fromMs: number, toMs: number): Promise<PrivateQuotaHistoryResult> => {
    try {
      const payload = await apiClient.get<unknown>(
        '/observability/quota/history/private',
        historyParams(fromMs, toMs)
      );
      return {
        status: 'ok',
        samples: normalizeQuotaHistorySamples(payload),
        credentials: normalizePrivateHistoryCredentials(payload),
      };
    } catch (error: unknown) {
      if (isDisabled(error)) return { status: 'disabled' };
      throw error;
    }
  },
};
