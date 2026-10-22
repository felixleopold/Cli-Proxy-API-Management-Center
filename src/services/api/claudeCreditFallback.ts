import { apiClient } from './client';
import { isRecord } from '@/utils/helpers';

const PATH = '/claude-credit-fallback';

/** Fork-only gateway switch: paid Anthropic API credits after Claude subscriptions run out. */
export interface ClaudeCreditFallback {
  /** False when the gateway has no API key to fall back to; the panel hides the switch. */
  configured: boolean;
  enabled: boolean;
  /** When the enabled switch turns itself off; null while off. */
  expiresAtMs: number | null;
  /** How long turning it on lasts. */
  durationSeconds: number;
}

export const normalizeClaudeCreditFallback = (data: unknown): ClaudeCreditFallback => {
  const record = isRecord(data) ? data : {};
  const expiresAtMs = typeof record.expires_at === 'string' ? Date.parse(record.expires_at) : NaN;
  const durationSeconds = Number(record.duration_seconds);
  return {
    configured: record.configured === true,
    enabled: record.enabled === true,
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
    durationSeconds: Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0,
  };
};

export const claudeCreditFallbackApi = {
  async get(): Promise<ClaudeCreditFallback> {
    return normalizeClaudeCreditFallback(await apiClient.get<unknown>(PATH));
  },

  async setEnabled(enabled: boolean): Promise<ClaudeCreditFallback> {
    return normalizeClaudeCreditFallback(await apiClient.put<unknown>(PATH, { enabled }));
  },
};
