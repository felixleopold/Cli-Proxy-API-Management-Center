/** Usage ledger: hourly API-equivalent cost per client key, model and provider. */

export interface UsageLedgerBucket {
  /** Start of the UTC hour, epoch ms. */
  hourMs: number;
  /** First 12 hex of sha256(client api key); '' is anonymous. */
  fingerprint: string;
  provider: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  priced: boolean;
}

export interface UsageClient {
  fingerprint: string;
  device: string;
  user: string;
  configured: boolean;
}

export type UsageClientLabel = Pick<UsageClient, 'fingerprint' | 'device' | 'user'>;

export interface UsageLedger {
  buckets: UsageLedgerBucket[];
  clients: UsageClient[];
  unpricedModels: string[];
}
