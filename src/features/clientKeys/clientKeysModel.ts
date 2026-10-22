/**
 * Client keys page logic: key status, budget state, the overview numbers, search/filter and
 * grouping, model pattern input, and the usage chart's day buckets. Pure, so it is tested
 * without a browser (tests/clientKeysModel.test.ts).
 */

import type { ClientKey, ClientKeyUsage } from '@/services/api/clientKeys';
import {
  addUnits,
  buildTimeBuckets,
  type BucketUnit,
  type StackedBucket,
  type TimeSpan,
} from '@/features/usage/usageModel';

// ---------- Status and budget ----------

export type KeyStatus = 'active' | 'disabled' | 'expired';

/** Disabled wins over expired: re-enabling an expired key would not make it work. */
export const keyStatus = (key: ClientKey, nowMs: number): KeyStatus =>
  key.disabled
    ? 'disabled'
    : key.expiresAtMs !== null && nowMs >= key.expiresAtMs
      ? 'expired'
      : 'active';

/** At or above this share of its budget a key counts as near its budget. */
export const NEAR_BUDGET_RATIO = 0.8;

/**
 * - `unlimited`: no budget (spend may still be known);
 * - `untracked`: a budget, but the ledger is off, so spend is unknown (the gateway refuses the key);
 * - `over`: spend reached the budget, so the gateway answers 429.
 */
export type BudgetLevel = 'unlimited' | 'untracked' | 'ok' | 'near' | 'over';

export interface BudgetState {
  level: BudgetLevel;
  spentUsd: number | null;
  budgetUsd: number;
  /** Spent over budget, unclamped; null without a budget or without spend. */
  ratio: number | null;
}

export function budgetState(key: ClientKey): BudgetState {
  const { spentUsdMonth: spentUsd, monthlyBudgetUsd: budgetUsd } = key;
  if (budgetUsd <= 0) return { level: 'unlimited', spentUsd, budgetUsd, ratio: null };
  if (spentUsd === null) return { level: 'untracked', spentUsd, budgetUsd, ratio: null };
  const ratio = spentUsd / budgetUsd;
  const level = ratio >= 1 ? 'over' : ratio >= NEAR_BUDGET_RATIO ? 'near' : 'ok';
  return { level, spentUsd, budgetUsd, ratio };
}

/**
 * A budgeted key whose month includes unpriced usage is refused (503) until the model gets a
 * price, because that usage would count as $0.
 */
export const unpricedBlocksKey = (key: ClientKey): boolean =>
  key.unpricedUsageMonth && key.monthlyBudgetUsd > 0;

// ---------- Overview ----------

export interface ClientKeysOverview {
  total: number;
  byStatus: Record<KeyStatus, number>;
  projects: number;
  /** This month's spend across keys; null while the usage ledger is off. */
  spentUsd: number | null;
  /** Sum of the budgets of budgeted keys. */
  budgetUsd: number;
  unlimited: number;
  near: number;
  over: number;
  unpriced: number;
}

export function summarizeKeys(keys: readonly ClientKey[], nowMs: number): ClientKeysOverview {
  const byStatus: Record<KeyStatus, number> = { active: 0, disabled: 0, expired: 0 };
  const overview: ClientKeysOverview = {
    total: keys.length,
    byStatus,
    projects: projectsOf(keys).length,
    // The ledger is on or off for every key at once.
    spentUsd: keys.some((key) => key.spentUsdMonth === null) ? null : 0,
    budgetUsd: 0,
    unlimited: 0,
    near: 0,
    over: 0,
    unpriced: 0,
  };
  for (const key of keys) {
    byStatus[keyStatus(key, nowMs)] += 1;
    if (overview.spentUsd !== null) overview.spentUsd += key.spentUsdMonth ?? 0;
    const budget = budgetState(key);
    if (budget.level === 'unlimited') overview.unlimited += 1;
    else overview.budgetUsd += budget.budgetUsd;
    if (budget.level === 'near') overview.near += 1;
    if (budget.level === 'over') overview.over += 1;
    if (key.unpricedUsageMonth) overview.unpriced += 1;
  }
  return overview;
}

// ---------- Filter and grouping ----------

export type Grouping = 'project' | 'flat';

/** Project filter: every project, or one project ('' is keys without a project). */
export type ProjectFilter = { kind: 'all' } | { kind: 'project'; project: string };

export interface KeyGroup {
  /** Stable React key and accessible label source. */
  id: string;
  /** null for the single flat group. */
  project: string | null;
  keys: ClientKey[];
  /** The group's spend this month; null while the ledger is off. */
  spentUsd: number | null;
}

const byName = (a: ClientKey, b: ClientKey) =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/** Named projects alphabetically. */
export const projectsOf = (keys: readonly ClientKey[]): string[] =>
  Array.from(new Set(keys.map((key) => key.project).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b)
  );

export function filterKeys(
  keys: readonly ClientKey[],
  query: string,
  project: ProjectFilter
): ClientKey[] {
  const needle = query.trim().toLowerCase();
  return keys.filter((key) => {
    if (project.kind === 'project' && key.project !== project.project) return false;
    if (!needle) return true;
    return [key.name, key.project, key.prefix, key.id, ...key.models].some((field) =>
      field.toLowerCase().includes(needle)
    );
  });
}

const sumSpend = (keys: readonly ClientKey[]): number | null =>
  keys.some((key) => key.spentUsdMonth === null)
    ? null
    : keys.reduce((total, key) => total + (key.spentUsdMonth ?? 0), 0);

/** By project: named projects alphabetically, keys without a project last; keys by name. */
export function groupKeys(keys: readonly ClientKey[], grouping: Grouping): KeyGroup[] {
  if (keys.length === 0) return [];
  if (grouping === 'flat') {
    const sorted = [...keys].sort(byName);
    return [{ id: 'flat', project: null, keys: sorted, spentUsd: sumSpend(sorted) }];
  }
  const projects = projectsOf(keys);
  if (keys.some((key) => !key.project)) projects.push('');
  return projects.map((project) => {
    const members = keys.filter((key) => key.project === project).sort(byName);
    return { id: `project:${project}`, project, keys: members, spentUsd: sumSpend(members) };
  });
}

// ---------- Model allowlist input ----------

/** Exact model names, or a prefix ending in `*`; `*` anywhere else is refused by the gateway. */
export const isValidModelPattern = (pattern: string): boolean =>
  pattern !== '' && !pattern.slice(0, -1).includes('*');

/** Splits typed or pasted text on commas and whitespace into trimmed, de-duplicated entries. */
export function addModelPatterns(current: readonly string[], text: string): string[] {
  const next = [...current];
  for (const entry of text.split(/[\s,]+/)) {
    if (entry && !next.includes(entry)) next.push(entry);
  }
  return next;
}

// ---------- Usage range and chart buckets ----------

export const USAGE_RANGES = ['month', '7d', '30d', '90d'] as const;
export type UsageRangeId = (typeof USAGE_RANGES)[number];

export interface UsageRangeWindow {
  /** The usage query, in UTC days like the gateway's budget month. */
  fromMs: number;
  toMs: number;
  /** The chart span, in local days that carry the same calendar dates. */
  span: TimeSpan;
  unit: BucketUnit;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local midnight of a UTC calendar day, so a `YYYY-MM-DD` bucket keeps its date on the axis. */
export function localDayMs(day: string): number {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date).getTime();
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * `month` is the budget month (UTC month to date) charted over the whole month, so the rest of
 * it reads as still to come. The day ranges end today, including it.
 */
export function usageRangeWindow(range: UsageRangeId, nowMs: number): UsageRangeWindow {
  const now = new Date(nowMs);
  if (range === 'month') {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    return {
      fromMs: Date.UTC(year, month, 1),
      toMs: nowMs,
      span: {
        startMs: new Date(year, month, 1).getTime(),
        endMs: new Date(year, month + 1, 1).getTime(),
      },
      unit: 'day',
    };
  }
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const fromMs = todayUtc - (days - 1) * DAY_MS;
  const unit: BucketUnit = range === '90d' ? 'week' : 'day';
  return {
    fromMs,
    toMs: nowMs,
    // Weeks start on Monday, so the first week column is clipped to the range.
    span: {
      startMs: localDayMs(utcDay(fromMs)),
      endMs: addUnits(localDayMs(utcDay(todayUtc)), 'day', 1),
    },
    unit,
  };
}

/** Series key of the single spend series. */
export const SPEND_SERIES = 'spend';

/** The usage's daily spend in the chart's buckets. */
export function stackUsageByDay(
  byDay: ClientKeyUsage['byDay'],
  window: Pick<UsageRangeWindow, 'span' | 'unit'>
): StackedBucket[] {
  const stacked = buildTimeBuckets(window.span, window.unit).map((span) => ({
    ...span,
    values: new Map<string, number>(),
    total: 0,
  }));
  for (const day of byDay) {
    const atMs = localDayMs(day.day);
    const bucket = stacked.find((item) => atMs >= item.startMs && atMs < item.endMs);
    if (!bucket) continue;
    bucket.values.set(SPEND_SERIES, (bucket.values.get(SPEND_SERIES) ?? 0) + day.costUsd);
    bucket.total += day.costUsd;
  }
  return stacked;
}

// ---------- Secret reveal ----------

/** Environment for Anthropic SDKs and Claude Code pointed at the gateway. */
export const anthropicEnvSnippet = (gatewayOrigin: string, secret: string): string =>
  `ANTHROPIC_BASE_URL=${gatewayOrigin}\nANTHROPIC_API_KEY=${secret}`;
