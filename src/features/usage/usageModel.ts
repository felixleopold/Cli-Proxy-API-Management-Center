/**
 * Usage page logic: the selection (a rolling range or one subscription's quota
 * window), chart buckets, subscription windows read from passive quota signals,
 * and ledger rollups (user → device → model). React-free; tests/usageModel.test.ts.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { deriveAuthFileIdentity } from '@/features/authFiles/identity';
import type { AuthFileItem, UsageClient, UsageLedgerBucket } from '@/types';
import { isRecord } from '@/utils/helpers';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';

export const WEEK_MS = 7 * DAY_MS;
/** Distinct series colors before the rest fold into "Other". */
export const SLOT_COUNT = 7;
/** Below this share of the quota, a straight-line estimate is mostly noise. */
export const ESTIMATE_MIN_PERCENT = 5;
/** How many earlier windows ‹ can step back through. */
export const MAX_WINDOWS_BACK = 12;
/** Series key for everything past the named slots. */
export const OTHER_KEY = '\u0000other';

export interface TimeSpan {
  startMs: number;
  endMs: number;
}

// ---------- Time buckets ----------

export type BucketUnit = 'hour' | 'sixHours' | 'day' | 'week';

export const RANGES = ['24h', '7d', '30d', '90d'] as const;
export type UsageRange = (typeof RANGES)[number];

const RANGE_PRESETS: Record<UsageRange, { unit: BucketUnit; durationMs: number }> = {
  '24h': { unit: 'hour', durationMs: DAY_MS },
  '7d': { unit: 'sixHours', durationMs: WEEK_MS },
  '30d': { unit: 'day', durationMs: 30 * DAY_MS },
  '90d': { unit: 'week', durationMs: 90 * DAY_MS },
};

/** Bucket size for an arbitrary span, matching the range presets. */
export function unitForSpan(spanMs: number): BucketUnit {
  if (spanMs <= 2 * DAY_MS) return 'hour';
  if (spanMs <= 2 * WEEK_MS) return 'sixHours';
  if (spanMs <= 62 * DAY_MS) return 'day';
  return 'week';
}

/** Start of the local bucket containing `ms`; weeks start Monday 00:00. */
export function floorToUnit(ms: number, unit: BucketUnit): number {
  // Ledger hours are UTC hours; local setters would pick the earlier of a repeated DST hour.
  const hourMs = Math.floor(ms / HOUR_MS) * HOUR_MS;
  if (unit === 'hour') return hourMs;
  const date = new Date(hourMs);
  if (unit === 'sixHours') {
    date.setHours(date.getHours() - (date.getHours() % 6));
    return date.getTime();
  }
  date.setHours(0);
  if (unit === 'week') date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return date.getTime();
}

/** Local calendar arithmetic, so days and weeks keep midnight across DST changes. */
export function addUnits(ms: number, unit: BucketUnit, count: number): number {
  if (unit === 'hour') return ms + count * HOUR_MS;
  const date = new Date(ms);
  if (unit === 'sixHours') date.setHours(date.getHours() + 6 * count);
  else date.setDate(date.getDate() + (unit === 'week' ? 7 : 1) * count);
  return date.getTime();
}

/** Local buckets covering [startMs, endMs); the first and last are clipped to the span. */
export function buildTimeBuckets(span: TimeSpan, unit: BucketUnit): TimeSpan[] {
  const buckets: TimeSpan[] = [];
  for (let cursor = floorToUnit(span.startMs, unit); cursor < span.endMs;) {
    const next = addUnits(cursor, unit, 1);
    buckets.push({ startMs: Math.max(cursor, span.startMs), endMs: Math.min(next, span.endMs) });
    cursor = next;
  }
  return buckets;
}

/** Axis label instants: hours every 4h, otherwise local midnights or week starts, thinned to ≤ 8. */
export function axisTicks(span: TimeSpan, unit: BucketUnit): number[] {
  const tickUnit: BucketUnit = unit === 'hour' ? 'hour' : unit === 'week' ? 'week' : 'day';
  const every = unit === 'hour' ? 4 : 1;
  const ticks: number[] = [];
  for (
    let at = floorToUnit(span.startMs, tickUnit);
    at < span.endMs;
    at = addUnits(at, tickUnit, 1)
  ) {
    if (at < span.startMs) continue;
    if (tickUnit === 'hour' && new Date(at).getHours() % every !== 0) continue;
    ticks.push(at);
  }
  const step = Math.ceil(ticks.length / 8);
  return ticks.filter((_, index) => index % step === 0);
}

// ---------- Subscriptions (credential quota windows) ----------

export interface QuotaWindow {
  /** Share used at the observation, 0–100; null when the signal was missing. */
  usedPercent: number | null;
  /** A reset instant as observed; may lie in the past when the reading is stale. */
  resetMs: number;
  periodMs: number;
}

export interface Subscription {
  /** Auth.ID, which the ledger records as `auth_id`. */
  id: string;
  provider: string;
  /** Account identity as on the Auth Files cards (email → project → file name). */
  name: string;
  observedAtMs: number | null;
  /** The longest reported window (weekly on current plans); null without one. */
  quota: QuotaWindow | null;
  /** A shorter session window (Claude 5h, Codex primary), when also reported. */
  session: QuotaWindow | null;
}

const readNumber = (value: string | undefined): number | null => {
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

type Signals = Map<string, string>;

function claudeWindow(signals: Signals, name: '7d' | '5h', periodMs: number): QuotaWindow | null {
  const resetSeconds = readNumber(signals.get(`anthropic-ratelimit-unified-${name}-reset`));
  if (resetSeconds === null) return null;
  // Utilization is a 0–1 fraction (the gateway treats < 1.0 as healthy).
  const utilization = readNumber(signals.get(`anthropic-ratelimit-unified-${name}-utilization`));
  return {
    usedPercent: utilization === null ? null : utilization * 100,
    resetMs: resetSeconds * 1000,
    periodMs,
  };
}

function codexWindow(
  signals: Signals,
  name: 'primary' | 'secondary',
  observedAtMs: number | null
): QuotaWindow | null {
  const minutes = readNumber(signals.get(`x-codex-${name}-window-minutes`));
  if (minutes === null || minutes <= 0) return null;
  const resetAt = readNumber(signals.get(`x-codex-${name}-reset-at`));
  const resetAfter = readNumber(signals.get(`x-codex-${name}-reset-after-seconds`));
  const resetMs =
    resetAt !== null
      ? resetAt * 1000
      : resetAfter !== null && observedAtMs !== null
        ? observedAtMs + resetAfter * 1000
        : null;
  if (resetMs === null) return null;
  return {
    usedPercent: readNumber(signals.get(`x-codex-${name}-used-percent`)),
    resetMs,
    periodMs: minutes * MINUTE_MS,
  };
}

/** A credential and its quota windows, from the passive `quota.signals` snapshot. */
export function parseSubscription(file: AuthFileItem): Subscription {
  const quota = isRecord(file.quota) ? file.quota : {};
  const rawSignals = isRecord(quota.signals) ? quota.signals : {};
  const signals: Signals = new Map(
    Object.entries(rawSignals).flatMap(([key, value]) =>
      typeof value === 'string' ? [[key.toLowerCase(), value.trim()] as const] : []
    )
  );
  const observedAt =
    typeof quota.observed_at === 'string' ? Date.parse(quota.observed_at) : Number.NaN;
  const observedAtMs = Number.isFinite(observedAt) ? observedAt : null;
  const provider = String(file.provider ?? file.type ?? '')
    .trim()
    .toLowerCase();

  let windows: QuotaWindow[] = [];
  if (provider === 'claude') {
    windows = [
      claudeWindow(signals, '7d', WEEK_MS),
      claudeWindow(signals, '5h', 5 * HOUR_MS),
    ].filter((window): window is QuotaWindow => window !== null);
  } else if (provider === 'codex') {
    windows = [
      codexWindow(signals, 'primary', observedAtMs),
      codexWindow(signals, 'secondary', observedAtMs),
    ].filter((window): window is QuotaWindow => window !== null);
  }
  windows.sort((a, b) => b.periodMs - a.periodMs);

  return {
    id: typeof file.id === 'string' ? file.id : file.name,
    provider,
    name: deriveAuthFileIdentity(file).primary,
    observedAtMs,
    quota: windows[0] ?? null,
    session: windows[1] ?? null,
  };
}

/**
 * The window containing `nowMs`, `stepsBack` windows earlier. A reset in the
 * past (a stale reading) rolls forward by whole periods, since windows repeat.
 */
export function quotaWindowSpan(quota: QuotaWindow, nowMs: number, stepsBack = 0): TimeSpan {
  const steps = Math.floor((nowMs - quota.resetMs) / quota.periodMs) + 1 - stepsBack;
  const endMs = quota.resetMs + steps * quota.periodMs;
  return { startMs: endMs - quota.periodMs, endMs };
}

/** Used share in the current window; null when the last reading predates its start. */
export function currentUsedPercent(
  quota: QuotaWindow,
  observedAtMs: number | null,
  nowMs: number
): number | null {
  if (quota.usedPercent === null || observedAtMs === null) return null;
  const span = quotaWindowSpan(quota, nowMs);
  return observedAtMs >= span.startMs && observedAtMs < span.endMs ? quota.usedPercent : null;
}

/** Straight-line spend at 100% of the quota; null below ESTIMATE_MIN_PERCENT. */
export function estimateFullQuota(spendUsd: number, usedPercent: number | null): number | null {
  if (usedPercent === null || usedPercent < ESTIMATE_MIN_PERCENT) return null;
  return (spendUsd / usedPercent) * 100;
}

// ---------- Selection ----------

export type Selection =
  | { kind: 'range'; range: UsageRange }
  | { kind: 'window'; subscriptionId: string; stepsBack: number };

export interface ResolvedSelection extends TimeSpan {
  unit: BucketUnit;
  /** Window mode: only usage served by this credential. */
  authId: string | null;
  /** The period before, cut at the same elapsed point. */
  previous: TimeSpan;
}

/**
 * The span a selection covers. Ranges end with the hour containing now;
 * windows may end in the future. `snapshotMs` (the ledger's `to`) bounds the
 * elapsed part, so the comparison never reaches past loaded data.
 */
export function resolveSelection(
  selection: Selection,
  subscriptions: readonly Subscription[],
  nowMs: number,
  snapshotMs = nowMs
): ResolvedSelection | null {
  let span: TimeSpan;
  let unit: BucketUnit;
  let authId: string | null = null;
  if (selection.kind === 'range') {
    // The full duration up to the end of the current ledger hour; chart buckets clip to it.
    const preset = RANGE_PRESETS[selection.range];
    unit = preset.unit;
    const endMs = floorToUnit(nowMs, 'hour') + HOUR_MS;
    span = { startMs: endMs - preset.durationMs, endMs };
  } else {
    const subscription = subscriptions.find((item) => item.id === selection.subscriptionId);
    if (!subscription?.quota) return null;
    span = quotaWindowSpan(subscription.quota, nowMs, selection.stepsBack);
    unit = unitForSpan(span.endMs - span.startMs);
    authId = subscription.id;
  }
  const length = span.endMs - span.startMs;
  const elapsed = Math.min(Math.max(snapshotMs - span.startMs, 0), length);
  return {
    ...span,
    unit,
    authId,
    previous: { startMs: span.startMs - length, endMs: span.startMs - length + elapsed },
  };
}

/** Earliest hour the ledger must cover: the comparison period and every current window. */
export function ledgerStartMs(
  selection: ResolvedSelection,
  subscriptions: readonly Subscription[],
  nowMs: number
): number {
  let startMs = selection.previous.startMs;
  for (const subscription of subscriptions) {
    if (subscription.quota) {
      startMs = Math.min(startMs, quotaWindowSpan(subscription.quota, nowMs).startMs);
    }
  }
  return Math.floor(startMs / HOUR_MS) * HOUR_MS;
}

// ---------- Ledger rollups ----------

export interface BucketFilter extends TimeSpan {
  /** Ledger provider id; null for all. */
  provider: string | null;
  /** Serving credential; null for all. */
  authId: string | null;
}

/** Buckets whose hour starts in [startMs, endMs) and match the provider/credential. */
export function filterBuckets(
  buckets: readonly UsageLedgerBucket[],
  filter: BucketFilter
): UsageLedgerBucket[] {
  return buckets.filter(
    (bucket) =>
      bucket.hourMs >= filter.startMs &&
      bucket.hourMs < filter.endMs &&
      (filter.provider === null || bucket.provider.toLowerCase() === filter.provider) &&
      (filter.authId === null || bucket.authId === filter.authId)
  );
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

export interface UsageRollup extends UsageTotals {
  users: UserRollup[];
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

/** Totals and the user → device → model tree of already-filtered buckets. */
export function rollupUsers(
  buckets: readonly UsageLedgerBucket[],
  clients: readonly UsageClient[]
): UsageRollup {
  const labels = new Map(clients.map((client) => [client.fingerprint, client]));
  const totals = zero();
  const users = new Map<
    string,
    UserRollup & { deviceMap: Map<string, DeviceRollup & { modelMap: Map<string, ModelRollup> }> }
  >();

  for (const bucket of buckets) {
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
    ...totals,
    users: byCost(users.values()).map(({ deviceMap, ...user }) => ({
      ...user,
      devices: byCost(deviceMap.values()).map(({ modelMap, ...device }) => ({
        ...device,
        models: byCost(modelMap.values()),
      })),
    })),
  };
}

export function sumCost(buckets: readonly UsageLedgerBucket[]): number {
  return buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0);
}

export interface StackedBucket extends TimeSpan {
  values: Map<string, number>;
  total: number;
}

/** Spend per series key in each time bucket; buckets must be sorted and contiguous. */
export function stackByTime(
  buckets: readonly UsageLedgerBucket[],
  spans: readonly TimeSpan[],
  keyOf: (bucket: UsageLedgerBucket) => string
): StackedBucket[] {
  const stacked = spans.map((span) => ({ ...span, values: new Map<string, number>(), total: 0 }));
  for (const bucket of buckets) {
    let low = 0;
    let high = stacked.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (bucket.hourMs < stacked[mid].startMs) high = mid - 1;
      else if (bucket.hourMs >= stacked[mid].endMs) low = mid + 1;
      else {
        const target = stacked[mid];
        const key = keyOf(bucket);
        target.values.set(key, (target.values.get(key) ?? 0) + bucket.costUsd);
        target.total += bucket.costUsd;
        break;
      }
    }
  }
  return stacked;
}

export interface SubscriptionSummary {
  subscription: Subscription;
  /** The current window; null when the credential reported none. */
  window: TimeSpan | null;
  usedPercent: number | null;
  sessionUsedPercent: number | null;
  /** Spend this credential served in its window, or in `fallback` without one. */
  costUsd: number;
  users: { user: string; costUsd: number }[];
  /** Spend at 100% of the quota, from the spend up to the quota reading. */
  estimateUsd: number | null;
}

export function summarizeSubscription(
  subscription: Subscription,
  buckets: readonly UsageLedgerBucket[],
  clients: readonly UsageClient[],
  nowMs: number,
  fallback: TimeSpan
): SubscriptionSummary {
  const { quota, session, observedAtMs } = subscription;
  const window = quota ? quotaWindowSpan(quota, nowMs) : null;
  const own = filterBuckets(buckets, {
    ...(window ?? fallback),
    provider: null,
    authId: subscription.id,
  });
  const rollup = rollupUsers(own, clients);
  const usedPercent = quota ? currentUsedPercent(quota, observedAtMs, nowMs) : null;
  // A reading inside the window implies both are set; compare spend at the same instant.
  const spendAtReading =
    window && observedAtMs !== null
      ? sumCost(own.filter((bucket) => bucket.hourMs < observedAtMs))
      : rollup.costUsd;
  return {
    subscription,
    window,
    usedPercent,
    sessionUsedPercent: session ? currentUsedPercent(session, observedAtMs, nowMs) : null,
    costUsd: rollup.costUsd,
    users: rollup.users.map(({ user, costUsd }) => ({ user, costUsd })),
    estimateUsd: estimateFullQuota(spendAtReading, usedPercent),
  };
}

// ---------- Series colors ----------

/** A categorical slot, "other" past SLOT_COUNT, or "none" for unassigned / unattributed. */
export type SeriesSlot = number | 'other' | 'none';

/**
 * Slots in the given order. The order comes from identity, not spend, so a
 * filter, range or new reading never repaints a series. '' is always "none".
 */
export function assignSlots(keys: readonly string[]): Map<string, SeriesSlot> {
  const slots = new Map<string, SeriesSlot>([['', 'none']]);
  keys
    .filter((key) => key && !slots.has(key))
    .forEach((key) => slots.set(key, slots.size - 1 < SLOT_COUNT ? slots.size - 1 : 'other'));
  return slots;
}

/** Users alphabetically, so a user's color only moves when users are added or renamed. */
export function userSlots(clients: readonly UsageClient[]): Map<string, SeriesSlot> {
  return assignSlots(
    Array.from(new Set(clients.map((client) => client.user).filter(Boolean))).sort((a, b) =>
      a.localeCompare(b)
    )
  );
}

/** Subscriptions by provider, then name. */
export function subscriptionSlots(subscriptions: readonly Subscription[]): Map<string, SeriesSlot> {
  return assignSlots(
    [...subscriptions]
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name))
      .map((subscription) => subscription.id)
  );
}

/** Series key of a slotted entity: itself, OTHER_KEY past the named slots. */
export const seriesKey = (slots: Map<string, SeriesSlot>, key: string): string => {
  const slot = slots.get(key);
  return slot === undefined || slot === 'other' ? OTHER_KEY : key;
};

/** Reset instants of each subscription strictly inside the span. */
export function resetMarkers(
  subscriptions: readonly Subscription[],
  span: TimeSpan,
  nowMs: number
): { atMs: number; subscription: Subscription }[] {
  return subscriptions.flatMap((subscription) => {
    const quota = subscription.quota;
    if (!quota) return [];
    const { endMs } = quotaWindowSpan(quota, nowMs);
    const first = endMs - Math.floor((endMs - span.startMs) / quota.periodMs) * quota.periodMs;
    const markers: { atMs: number; subscription: Subscription }[] = [];
    for (let atMs = first; atMs < span.endMs; atMs += quota.periodMs) {
      if (atMs > span.startMs) markers.push({ atMs, subscription });
    }
    return markers;
  });
}

// ---------- Client labels ----------

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
