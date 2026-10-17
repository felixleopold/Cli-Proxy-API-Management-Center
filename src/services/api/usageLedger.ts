import { apiClient } from './client';
import { isRecord } from '@/utils/helpers';
import type {
  UsageClient,
  UsageClientLabel,
  UsageLedger,
  UsageLedgerBucket,
} from '@/types/usageLedger';

const BASE = '/observability/usage';

const num = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const normalizeBucket = (raw: Record<string, unknown>): UsageLedgerBucket | null => {
  const hourMs = Date.parse(str(raw.hour));
  if (!Number.isFinite(hourMs)) return null;
  return {
    hourMs,
    fingerprint: str(raw.fingerprint),
    provider: str(raw.provider),
    authId: str(raw.auth_id),
    model: str(raw.model),
    requests: num(raw.requests),
    inputTokens: num(raw.input_tokens),
    outputTokens: num(raw.output_tokens),
    cacheReadTokens: num(raw.cache_read_tokens),
    cacheWriteTokens: num(raw.cache_write_tokens),
    reasoningTokens: num(raw.reasoning_tokens),
    costUsd: num(raw.cost_usd),
    priced: raw.priced !== false,
  };
};

const normalizeClients = (value: unknown): UsageClient[] =>
  list(value).map((raw) => ({
    fingerprint: str(raw.fingerprint),
    device: str(raw.device),
    user: str(raw.user),
    configured: raw.configured === true,
  }));

export const normalizeUsageLedger = (data: unknown, requestedToMs: number): UsageLedger => {
  const record = isRecord(data) ? data : {};
  const toMs = Date.parse(str(record.to));
  return {
    toMs: Number.isFinite(toMs) ? toMs : requestedToMs,
    buckets: list(record.buckets)
      .map(normalizeBucket)
      .filter((bucket): bucket is UsageLedgerBucket => bucket !== null),
    clients: normalizeClients(record.clients),
    unpricedModels: Array.isArray(record.unpriced_models)
      ? record.unpriced_models.map(str).filter(Boolean)
      : [],
  };
};

export const usageLedgerApi = {
  async getLedger(fromMs: number, toMs: number): Promise<UsageLedger> {
    const data = await apiClient.get<unknown>(`${BASE}/ledger`, {
      params: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    });
    return normalizeUsageLedger(data, toMs);
  },

  async getClients(): Promise<UsageClient[]> {
    const data = await apiClient.get<unknown>(`${BASE}/clients`);
    return normalizeClients(isRecord(data) ? data.clients : undefined);
  },

  saveClients: (clients: UsageClientLabel[]) => apiClient.put(`${BASE}/clients`, { clients }),
};
