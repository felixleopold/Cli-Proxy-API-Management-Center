import { apiClient } from './client';
import { isRecord } from '@/utils/helpers';

/**
 * Fork-only client keys: per-app API keys with a monthly budget, a model allowlist and a
 * credential pin, plus manager tokens that may administer them. Every route answers 409 while
 * `client-keys.enabled` is off; the usage route also while `usage-ledger.enabled` is off.
 */

export type ClientKeyCredentials = 'api-key' | 'any';

export interface ClientKey {
  id: string;
  name: string;
  project: string;
  /** Display form of the secret, its start and end (`sk-cpa-ab12…yz89`), safe to show. */
  prefix: string;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number | null;
  disabled: boolean;
  /** Empty allows every model. */
  models: string[];
  credentials: ClientKeyCredentials;
  /** 0 means unlimited. */
  monthlyBudgetUsd: number;
  /** This UTC month's priced spend; null while the usage ledger is off. */
  spentUsdMonth: number | null;
  /** This month's usage includes models without a price. */
  unpricedUsageMonth: boolean;
}

export interface ClientKeyInput {
  name: string;
  project: string;
  models: string[];
  credentials: ClientKeyCredentials;
  monthlyBudgetUsd: number;
  /** RFC3339, or '' for no expiry. */
  expiresAt: string;
}

export interface ClientKeyUsageTotals {
  costUsd: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ClientKeyUsage {
  fromMs: number;
  toMs: number;
  totalUsd: number;
  /** Models (with their speed tier) whose usage has no price. */
  unpriced: string[];
  /** UTC days, `YYYY-MM-DD`, ascending. */
  byDay: Array<ClientKeyUsageTotals & { day: string }>;
  byModel: Array<ClientKeyUsageTotals & { model: string }>;
}

export interface ClientKeyManager {
  id: string;
  name: string;
  /** Last characters of the token. */
  hint: string;
  createdAtMs: number;
}

/** A create or rotate result: the only time the secret is available. */
export interface ClientKeyWithSecret {
  key: ClientKey;
  secret: string;
}

const BASE = '/client-keys';
const MANAGERS = '/client-key-managers';

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const num = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const timeMs = (value: unknown): number | null => {
  const ms = Date.parse(str(value));
  return Number.isFinite(ms) ? ms : null;
};

const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

export const normalizeClientKey = (raw: Record<string, unknown>): ClientKey => ({
  id: str(raw.id),
  name: str(raw.name),
  project: str(raw.project),
  prefix: str(raw.prefix),
  createdAtMs: timeMs(raw.created_at) ?? 0,
  updatedAtMs: timeMs(raw.updated_at) ?? 0,
  expiresAtMs: timeMs(raw.expires_at),
  disabled: raw.disabled === true,
  models: Array.isArray(raw.models) ? raw.models.map(str).filter(Boolean) : [],
  credentials: raw.credentials === 'any' ? 'any' : 'api-key',
  monthlyBudgetUsd: Math.max(0, num(raw.monthly_budget_usd)),
  spentUsdMonth:
    raw.spent_usd_month === null || raw.spent_usd_month === undefined
      ? null
      : num(raw.spent_usd_month),
  unpricedUsageMonth: raw.unpriced_usage_month === true,
});

const withSecret = (data: unknown): ClientKeyWithSecret => {
  const record = isRecord(data) ? data : {};
  return { key: normalizeClientKey(record), secret: str(record.secret) };
};

const normalizeTotals = (raw: Record<string, unknown>): ClientKeyUsageTotals => ({
  costUsd: num(raw.cost_usd),
  requests: num(raw.requests),
  inputTokens: num(raw.input_tokens),
  outputTokens: num(raw.output_tokens),
  cacheReadTokens: num(raw.cache_read_tokens),
  cacheWriteTokens: num(raw.cache_write_tokens),
});

export const normalizeClientKeyUsage = (data: unknown): ClientKeyUsage => {
  const record = isRecord(data) ? data : {};
  return {
    fromMs: timeMs(record.from) ?? 0,
    toMs: timeMs(record.to) ?? 0,
    totalUsd: num(record.total_usd),
    unpriced: Array.isArray(record.unpriced) ? record.unpriced.map(str).filter(Boolean) : [],
    byDay: list(record.by_day).map((raw) => ({ day: str(raw.day), ...normalizeTotals(raw) })),
    byModel: list(record.by_model).map((raw) => ({
      model: str(raw.model),
      ...normalizeTotals(raw),
    })),
  };
};

const normalizeManager = (raw: Record<string, unknown>): ClientKeyManager => ({
  id: str(raw.id),
  name: str(raw.name),
  hint: str(raw.hint),
  createdAtMs: timeMs(raw.created_at) ?? 0,
});

const serializeInput = (input: ClientKeyInput) => ({
  name: input.name,
  project: input.project,
  models: input.models,
  credentials: input.credentials,
  monthly_budget_usd: input.monthlyBudgetUsd,
  expires_at: input.expiresAt,
});

const keyPath = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

export const clientKeysApi = {
  async list(): Promise<ClientKey[]> {
    const data = await apiClient.get<unknown>(BASE);
    return list(isRecord(data) ? data.keys : undefined).map(normalizeClientKey);
  },

  async create(input: ClientKeyInput): Promise<ClientKeyWithSecret> {
    const { expires_at, ...rest } = serializeInput(input);
    // Create has no expiry to clear; omit an empty one.
    return withSecret(
      await apiClient.post<unknown>(BASE, expires_at ? { ...rest, expires_at } : rest)
    );
  },

  async update(id: string, input: ClientKeyInput): Promise<ClientKey> {
    const data = await apiClient.patch<unknown>(keyPath(id), serializeInput(input));
    return normalizeClientKey(isRecord(data) ? data : {});
  },

  async setDisabled(id: string, disabled: boolean): Promise<ClientKey> {
    const data = await apiClient.patch<unknown>(keyPath(id), { disabled });
    return normalizeClientKey(isRecord(data) ? data : {});
  },

  async rotate(id: string): Promise<ClientKeyWithSecret> {
    return withSecret(await apiClient.post<unknown>(`${keyPath(id)}/rotate`));
  },

  revoke: (id: string) => apiClient.delete(keyPath(id)),

  async usage(id: string, fromMs: number, toMs: number): Promise<ClientKeyUsage> {
    const data = await apiClient.get<unknown>(`${keyPath(id)}/usage`, {
      params: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    });
    return normalizeClientKeyUsage(data);
  },

  async listManagers(): Promise<ClientKeyManager[]> {
    const data = await apiClient.get<unknown>(MANAGERS);
    return list(isRecord(data) ? data.managers : undefined).map(normalizeManager);
  },

  async createManager(name: string): Promise<{ manager: ClientKeyManager; token: string }> {
    const data = await apiClient.post<unknown>(MANAGERS, { name });
    const record = isRecord(data) ? data : {};
    return { manager: normalizeManager(record), token: str(record.token) };
  },

  revokeManager: (id: string) => apiClient.delete(`${MANAGERS}/${encodeURIComponent(id)}`),
};
