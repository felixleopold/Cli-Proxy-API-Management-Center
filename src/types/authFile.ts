/**
 * 认证文件相关类型
 * 基于原项目 src/modules/auth-files.js
 */

import type { RecentRequestBucket } from '@/utils/recentRequests';

export type AuthFileType =
  | 'qwen'
  | 'kimi'
  | 'gemini'
  | 'aistudio'
  | 'claude'
  | 'codex'
  | 'devin'
  | 'meta'
  | 'antigravity'
  | 'xai'
  | 'iflow'
  | 'vertex'
  | 'empty'
  | 'unknown';

export interface AuthFileCooldown {
  scope: 'model' | 'credential';
  modelKey?: string;
  reason: string;
  retryAt: string;
  remainingSeconds: number;
  backoffLevel?: number;
  httpStatus?: number;
}

export interface AuthFileCooldownSnapshot {
  /** Server observation time, not the start of the cooldown. */
  observedAt?: string;
  /** Local receipt time anchors relative timers without relying on synchronized clocks. */
  receivedAtMs: number;
  /** null = runtime state unknown; [] = known, with no active timers. */
  records: AuthFileCooldown[] | null;
}

export type AuthFilePaceMode = 'flash' | 'shield';

export const ROUTING_STATES = [
  'target',
  'available',
  'flash',
  'shield',
  'paused',
  'reserve_hold',
  'cooldown',
  'exhausted',
  'disabled',
  'error',
] as const;
export type AuthFileRoutingState = (typeof ROUTING_STATES)[number];

export interface AuthFileRoutingStatus {
  state: AuthFileRoutingState;
  reason: string;
  window?: 'five_hour' | 'weekly';
  /** When the state lifts (ms), if the gateway knows. */
  untilMs?: number;
}

export interface AuthFileItem {
  name: string;
  type?: AuthFileType | string;
  provider?: string;
  /**
   * 凭证账号邮箱（后端 auth_files 两条分支都会填：磁盘扫描读 JSON 的 email 字段，
   * 注册表读 Metadata/Attributes）。卡片主行用它领衔。
   * 注意：后端还会下发 account/account_type，但 api-key 类凭证的 account 就是
   * API key 本身（AccountInfo() → return "api_key", apiKey），**绝不可用于展示或搜索**。
   */
  email?: string;
  /** GCP / Vertex 项目 ID，账号邮箱缺失时作为身份回落。 */
  projectId?: string;
  size?: number;
  authIndex?: string | number | null;
  runtimeOnly?: boolean | string;
  disabled?: boolean;
  unavailable?: boolean;
  status?: string;
  statusMessage?: string;
  lastRefresh?: string | number;
  modified?: number;
  priority?: number;
  weight?: number;
  /** Plan size in base-plan units (Max $200 = 10, Pro/Plus = 1); absent when not set. */
  planMultiplier?: number;
  /** The gateway's usage cap, strictly between 0 and 100; absent without a cap. */
  usageCapPercent?: number;
  /** Subscription plan name; Claude's pro, max and ultra set the gateway's plan weights. */
  plan?: string;
  /** The gateway's pool weight per window in Pro-plan units; absent on older gateways. */
  planWeightFiveHour?: number;
  planWeightWeekly?: number;
  /**
   * Lender reserve per window, 0..100, as the gateway applies it: the explicit
   * reserve, else 100 − usage cap. Absent when neither is set.
   */
  reserveFiveHourPercent?: number;
  reserveWeeklyPercent?: number;
  /** Who lends this account to the pool. */
  lender?: string;
  /**
   * The lender is a credential group holding this account: requests routed in it
   * spend the reserve, so the whole window is ours.
   */
  lenderGroup?: true;
  /** End of the lender's temporary reserve release (ms); absent when none is active. */
  lenderReserveOverrideUntilMs?: number;
  /** The share of each window the release still keeps for the lender, 0..100. */
  lenderReserveOverrideKeepPercent?: number;
  /** When a Claude subscription started (ms), as the gateway recorded it; absent until it has. */
  subscriptionCreatedAtMs?: number;
  /** Day of the month (1-31) the plan renews, as set on the gateway; overrides any estimate. */
  renewalDay?: number;
  /** Display name set on the gateway; rows fall back to the email. */
  nickname?: string;
  /** Models this account serves ahead of every priority tier; absent when none. */
  preferredModels?: string[];
  /**
   * The ledger user a private credential is reserved for: it serves only their
   * requests, records no usage, and Usage & quota leaves it out entirely.
   */
  privateUser?: string;
  /** Pace override: `flash` routes here first, `shield` only when nothing else is eligible. */
  paceMode?: AuthFilePaceMode;
  /** End of the pace override (ms). */
  paceUntilMs?: number;
  /** End of a pause (ms): the account takes no traffic but still counts toward pool capacity. */
  pausedUntilMs?: number;
  /** Why the gateway routes to this credential or not, right now; absent on older gateways. */
  routingStatus?: AuthFileRoutingStatus;
  /** When the credential was retired (ms): disabled and out of the pool, metadata kept. */
  retiredAtMs?: number;
  note?: string;
  success?: unknown;
  failed?: unknown;
  /** 归一化后的累计成功/失败计数（由 API 边界从 success/failed 生字段填充）。 */
  successCount?: number;
  failureCount?: number;
  recent_requests?: RecentRequestBucket[];
  recentRequests?: RecentRequestBucket[];
  /** Absent on older servers. Never interpreted as credential health. */
  cooldownSnapshot?: AuthFileCooldownSnapshot;
  [key: string]: unknown;
}

export interface AuthFilesResponse {
  files: AuthFileItem[];
  total?: number;
  observed_at?: unknown;
  observedAt?: string;
}
