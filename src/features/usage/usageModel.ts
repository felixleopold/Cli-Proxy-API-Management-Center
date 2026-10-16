/**
 * Usage page logic: weekly windows, their anchor, and ledger rollups
 * (window → user → device → model). React-free; tests/usageModel.test.ts.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { ClaudeQuotaState, UsageClient, UsageLedgerBucket } from '@/types';
import { DAY_MS } from '@/utils/time/durations';

export const WEEK_MS = 7 * DAY_MS;
export const WINDOW_COUNT = 8;
/** Every window shown starts within this span before now, in either anchor mode. */
export const LEDGER_SPAN_MS = WINDOW_COUNT * WEEK_MS;
/** Distinct user colors before the rest fold into "Other". */
export const USER_SLOT_COUNT = 7;

export type WeekAnchorMode = 'claude' | 'calendar';

/** The anchor actually used; `claude` mode falls back to calendar weeks. */
export type WeekAnchor = { kind: 'claude'; resetMs: number } | { kind: 'calendar' };

export interface UsageWindow {
  startMs: number;
  endMs: number;
  current: boolean;
}

export interface UsageTotals {
  costUsd: number;
  requests: number;
  tokens: number;
}

export interface ModelRollup extends UsageTotals {
  model: string;
  provider: string;
}

export interface DeviceRollup extends UsageTotals {
  fingerprint: string;
  /** Operator-set name; '' when unlabelled. */
  device: string;
  models: ModelRollup[];
}

export interface UserRollup extends UsageTotals {
  /** '' groups every key without a user ("Unassigned"). */
  user: string;
  devices: DeviceRollup[];
}

export interface WindowRollup extends UsageTotals {
  window: UsageWindow;
  users: UserRollup[];
}

/** Claude `seven_day` reset instants across the cached credential quotas. */
export function claudeSevenDayResets(quota: Record<string, ClaudeQuotaState>): number[] {
  return Object.values(quota).flatMap((state) =>
    state.windows
      .filter((window) => window.id === 'seven-day' && typeof window.resetAtMs === 'number')
      .map((window) => window.resetAtMs as number)
  );
}

/**
 * Earliest reset after `nowMs`. A reset already in the past (a stale cache) is
 * rolled forward by whole weeks, since the seven-day window repeats.
 */
export function earliestUpcomingReset(resets: readonly number[], nowMs: number): number | null {
  let earliest: number | null = null;
  for (const reset of resets) {
    if (!Number.isFinite(reset)) continue;
    const next =
      reset > nowMs ? reset : reset + (Math.floor((nowMs - reset) / WEEK_MS) + 1) * WEEK_MS;
    if (earliest === null || next < earliest) earliest = next;
  }
  return earliest;
}

export function resolveWeekAnchor(
  mode: WeekAnchorMode,
  claudeResets: readonly number[],
  nowMs: number
): WeekAnchor {
  if (mode === 'claude') {
    const resetMs = earliestUpcomingReset(claudeResets, nowMs);
    if (resetMs !== null) return { kind: 'claude', resetMs };
  }
  return { kind: 'calendar' };
}

/** Local Monday 00:00 of the week containing `nowMs`, shifted by `weeksBack`. */
function calendarWeekStart(nowMs: number, weeksBack: number): number {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  // Date arithmetic rather than WEEK_MS keeps local midnight across DST changes.
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7) - weeksBack * 7);
  return date.getTime();
}

/** The last `count` windows, oldest first; the final one contains `nowMs`. */
export function buildWeekWindows(anchor: WeekAnchor, nowMs: number, count = WINDOW_COUNT) {
  return Array.from({ length: count }, (_, index): UsageWindow => {
    const weeksBack = count - 1 - index;
    if (anchor.kind === 'claude') {
      const endMs = anchor.resetMs - weeksBack * WEEK_MS;
      return { startMs: endMs - WEEK_MS, endMs, current: weeksBack === 0 };
    }
    return {
      startMs: calendarWeekStart(nowMs, weeksBack),
      endMs: calendarWeekStart(nowMs, weeksBack - 1),
      current: weeksBack === 0,
    };
  });
}

const bucketTokens = (bucket: UsageLedgerBucket) =>
  bucket.inputTokens + bucket.outputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens;

const addTotals = (target: UsageTotals, bucket: UsageLedgerBucket) => {
  target.costUsd += bucket.costUsd;
  target.requests += bucket.requests;
  target.tokens += bucketTokens(bucket);
};

const zero = (): UsageTotals => ({ costUsd: 0, requests: 0, tokens: 0 });

const byCost = <T extends UsageTotals>(items: Iterable<T>): T[] =>
  Array.from(items).sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests);

/** Group ledger buckets into each window by the bucket's hour start. */
export function rollupWindows(
  buckets: readonly UsageLedgerBucket[],
  clients: readonly UsageClient[],
  windows: readonly UsageWindow[]
): WindowRollup[] {
  const labels = new Map(clients.map((client) => [client.fingerprint, client]));

  return windows.map((window) => {
    const totals = zero();
    const users = new Map<
      string,
      UserRollup & { deviceMap: Map<string, DeviceRollup & { modelMap: Map<string, ModelRollup> }> }
    >();

    for (const bucket of buckets) {
      if (bucket.hourMs < window.startMs || bucket.hourMs >= window.endMs) continue;
      const label = labels.get(bucket.fingerprint);
      const userName = label?.user ?? '';

      let user = users.get(userName);
      if (!user) {
        user = { user: userName, ...zero(), devices: [], deviceMap: new Map() };
        users.set(userName, user);
      }
      let device = user.deviceMap.get(bucket.fingerprint);
      if (!device) {
        device = {
          fingerprint: bucket.fingerprint,
          device: label?.device ?? '',
          ...zero(),
          models: [],
          modelMap: new Map(),
        };
        user.deviceMap.set(bucket.fingerprint, device);
      }
      const modelKey = `${bucket.provider}\u0000${bucket.model}`;
      let model = device.modelMap.get(modelKey);
      if (!model) {
        model = { model: bucket.model, provider: bucket.provider, ...zero() };
        device.modelMap.set(modelKey, model);
      }

      addTotals(totals, bucket);
      addTotals(user, bucket);
      addTotals(device, bucket);
      addTotals(model, bucket);
    }

    return {
      window,
      ...totals,
      users: byCost(users.values()).map(({ deviceMap, ...user }) => ({
        ...user,
        devices: byCost(deviceMap.values()).map(({ modelMap, ...device }) => ({
          ...device,
          models: byCost(modelMap.values()),
        })),
      })),
    };
  });
}

/** Cost of buckets whose hour starts in [startMs, endMs) — the pace comparison. */
export function costBetween(
  buckets: readonly UsageLedgerBucket[],
  startMs: number,
  endMs: number
): number {
  let cost = 0;
  for (const bucket of buckets) {
    if (bucket.hourMs >= startMs && bucket.hourMs < endMs) cost += bucket.costUsd;
  }
  return cost;
}

/**
 * Spend in `previous` up to the point `current` had reached at `snapshotMs`, the
 * ledger's `to` (not a ticking clock, so an open page doesn't stretch the range
 * past the data). Clamped to `previous.endMs` so a DST-long week can't reach
 * into the current one.
 */
export function paceCost(
  buckets: readonly UsageLedgerBucket[],
  previous: UsageWindow,
  current: UsageWindow,
  snapshotMs: number
): number {
  const endMs = Math.min(previous.startMs + (snapshotMs - current.startMs), previous.endMs);
  return costBetween(buckets, previous.startMs, endMs);
}

export type UserSlot = number | 'other' | 'unassigned';

/**
 * Stable color slot per user across every displayed window: users are ranked
 * once by spend over the whole range, so selecting a window never repaints them.
 * Users past USER_SLOT_COUNT share "other"; '' is always "unassigned".
 */
export function assignUserSlots(rollups: readonly WindowRollup[]): Map<string, UserSlot> {
  const totals = new Map<string, number>();
  for (const rollup of rollups) {
    for (const user of rollup.users) {
      if (user.user) totals.set(user.user, (totals.get(user.user) ?? 0) + user.costUsd);
    }
  }
  const ranked = Array.from(totals.entries()).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  );
  const slots = new Map<string, UserSlot>([['', 'unassigned']]);
  ranked.forEach(([user], index) => slots.set(user, index < USER_SLOT_COUNT ? index : 'other'));
  return slots;
}

/** Go `usageledger.Fingerprint`: first 12 hex of sha256 of the trimmed key; '' for none. */
export function clientKeyFingerprint(apiKey: string): string {
  const key = apiKey.trim();
  return key ? bytesToHex(sha256(new TextEncoder().encode(key))).slice(0, 12) : '';
}

export interface ClientRow {
  fingerprint: string;
  device: string;
  user: string;
  /** The configured api key with this fingerprint, if any. */
  apiKey: string | null;
}

/**
 * Every labellable client: those the backend has seen plus configured keys that
 * have not been used yet. The anonymous fingerprint cannot be labelled.
 */
export function buildClientRows(
  clients: readonly UsageClient[],
  apiKeys: readonly string[]
): ClientRow[] {
  const keyByFingerprint = new Map(
    apiKeys.flatMap((key) => {
      const fingerprint = clientKeyFingerprint(key);
      return fingerprint ? [[fingerprint, key] as const] : [];
    })
  );
  const rows = new Map<string, ClientRow>();
  for (const client of clients) {
    if (!client.fingerprint) continue;
    rows.set(client.fingerprint, {
      fingerprint: client.fingerprint,
      device: client.device,
      user: client.user,
      apiKey: keyByFingerprint.get(client.fingerprint) ?? null,
    });
  }
  for (const [fingerprint, apiKey] of keyByFingerprint) {
    if (!rows.has(fingerprint))
      rows.set(fingerprint, { fingerprint, device: '', user: '', apiKey });
  }
  // Unassigned first: those are the rows that need the operator's attention.
  return Array.from(rows.values()).sort(
    (a, b) =>
      Number(Boolean(a.user)) - Number(Boolean(b.user)) ||
      a.user.localeCompare(b.user) ||
      a.device.localeCompare(b.device) ||
      a.fingerprint.localeCompare(b.fingerprint)
  );
}

export function formatUsd(value: number, locale?: string, compact = false): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: compact ? 0 : 2,
    minimumFractionDigits: compact ? 0 : 2,
  }).format(value);
}
