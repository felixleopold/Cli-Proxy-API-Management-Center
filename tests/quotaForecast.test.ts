import { describe, expect, test } from 'bun:test';
import type { AuthFileItem } from '../src/types';
import {
  DAY_MS,
  HOUR_MS,
  buildPools,
  credentialNow,
  drainBuckets,
  drainEdges,
  poolHistory,
  projectPool,
  readPoolCredential,
  summarizePool,
  valueAt,
} from '../src/features/quota/quotaForecastModel';
import type { PoolCredential, ProviderPool } from '../src/features/quota/quotaForecastModel';
import {
  normalizeQuotaHistorySamples,
  type QuotaHistorySample,
} from '../src/services/api/quotaHistory';

const NOW = Date.UTC(2026, 9, 17, 12);
const WEEK_MS = 7 * DAY_MS;
const unix = (ms: number) => String(ms / 1000);

const file = (provider: string, signals: Record<string, string>, extra = {}): AuthFileItem => ({
  name: `${provider}.json`,
  id: `${provider}-1`,
  provider,
  quota: { observed_at: new Date(NOW - HOUR_MS).toISOString(), signals },
  ...extra,
});

const credential = (overrides: Partial<PoolCredential> = {}): PoolCredential => ({
  authId: 'a',
  window: 'weekly',
  periodMs: WEEK_MS,
  usedPercent: 0,
  resetAtMs: NOW + 3 * DAY_MS,
  observedAtMs: NOW,
  ...overrides,
});

const pool = (...credentials: PoolCredential[]): ProviderPool => ({
  provider: 'claude',
  credentials,
  capacity: credentials.length * 100,
});

const sample = (overrides: Partial<QuotaHistorySample>): QuotaHistorySample => ({
  atMs: NOW,
  authId: 'a',
  provider: 'claude',
  window: 'weekly',
  windowMinutes: 10080,
  usedPercent: 0,
  resetAtMs: NOW + 3 * DAY_MS,
  ...overrides,
});

describe('readPoolCredential', () => {
  test('Claude reads the 7-day window, converting the 0..1 utilization to percent', () => {
    const result = readPoolCredential(
      file('claude', {
        'Anthropic-Ratelimit-Unified-5h-Utilization': '0.9',
        'Anthropic-Ratelimit-Unified-5h-Reset': unix(NOW + HOUR_MS),
        'Anthropic-Ratelimit-Unified-7d-Utilization': '0.25',
        'Anthropic-Ratelimit-Unified-7d-Reset': unix(NOW + DAY_MS),
      })
    );
    expect(result).toMatchObject({
      window: 'weekly',
      periodMs: WEEK_MS,
      usedPercent: 25,
      resetAtMs: NOW + DAY_MS,
    });
  });

  test('Codex prefers whichever window is weekly, and falls back to reset-after-seconds', () => {
    const result = readPoolCredential(
      file('codex', {
        'X-Codex-Primary-Used-Percent': '80',
        'X-Codex-Primary-Window-Minutes': '300',
        'X-Codex-Primary-Reset-At': unix(NOW + HOUR_MS),
        'X-Codex-Secondary-Used-Percent': '40',
        'X-Codex-Secondary-Window-Minutes': '10080',
        'X-Codex-Secondary-Reset-After-Seconds': '7200',
      })
    );
    expect(result).toMatchObject({ window: 'weekly', usedPercent: 40, resetAtMs: NOW + HOUR_MS });
  });

  test('a provider without a weekly window pools its first window; disabled files are skipped', () => {
    const session = file('codex', {
      'X-Codex-Primary-Used-Percent': '10',
      'X-Codex-Primary-Window-Minutes': '300',
      'X-Codex-Primary-Reset-At': unix(NOW + HOUR_MS),
    });
    expect(readPoolCredential(session)).toMatchObject({ window: 'session', periodMs: 5 * HOUR_MS });
    expect(buildPools([session, { ...session, id: 'off', disabled: true }])).toEqual([
      expect.objectContaining({ provider: 'codex', capacity: 100 }),
    ]);
  });
});

describe('current state and projection', () => {
  test('a reset in the past means full quota with the next reset one period later', () => {
    const state = credentialNow(credential({ usedPercent: 70, resetAtMs: NOW - HOUR_MS }), NOW);
    expect(state.usedPercent).toBe(0);
    expect(state.resetAtMs).toBe(NOW - HOUR_MS + WEEK_MS);
  });

  test('summary pools remaining, pace and the earliest reset', () => {
    // 4 days into a 7-day window with 48% used: 0.5% per hour.
    const a = credential({ usedPercent: 48, resetAtMs: NOW + 3 * DAY_MS });
    const b = credential({ authId: 'b', usedPercent: 0, resetAtMs: NOW + 5 * DAY_MS });
    const summary = summarizePool(pool(a, b), NOW);
    expect(summary.remaining).toBe(152);
    expect(summary.capacity).toBe(200);
    expect(summary.pacePerHour).toBeCloseTo(0.5);
    expect(summary.nextReset?.atMs).toBe(NOW + 3 * DAY_MS);
    // By the reset another 72h at 0.5%/h is used: 48 + 36.
    expect(summary.nextReset?.restorePercent).toBeCloseTo(84);
  });

  test('projection declines at pace, floors at zero and jumps back to 100 at each reset', () => {
    // 50% used one day in: 50/24 % per hour, empty one day from now.
    const c = credential({ usedPercent: 50, resetAtMs: NOW + 6 * DAY_MS });
    const series = projectPool(pool(c), NOW, NOW + 8 * DAY_MS);
    expect(valueAt(series, NOW)).toBeCloseTo(50);
    expect(valueAt(series, NOW + 12 * HOUR_MS)).toBeCloseTo(25);
    expect(valueAt(series, NOW + 3 * DAY_MS)).toBe(0);
    expect(valueAt(series, NOW + 6 * DAY_MS)).toBe(100);
    expect(valueAt(series, NOW + 6.5 * DAY_MS)).toBeCloseTo(75);
    expect(series.at(-1)?.t).toBe(NOW + 8 * DAY_MS);
  });
});

describe('history', () => {
  test('values hold flat between samples and drop to full at reset', () => {
    const c = credential({ usedPercent: 10, resetAtMs: NOW + 6 * DAY_MS, observedAtMs: NOW });
    const samples = [
      sample({ atMs: NOW - 2 * DAY_MS, usedPercent: 60, resetAtMs: NOW - DAY_MS }),
      sample({ atMs: NOW, usedPercent: 10, resetAtMs: NOW + 6 * DAY_MS }),
    ];
    const series = poolHistory(pool(c), samples, NOW - 3 * DAY_MS, NOW);
    // Unknown before the first sample rather than invented.
    expect(series[0].t).toBe(NOW - 2 * DAY_MS);
    expect(valueAt(series, NOW - 1.5 * DAY_MS)).toBe(40);
    expect(valueAt(series, NOW - 0.5 * DAY_MS)).toBe(100);
    expect(valueAt(series, NOW)).toBe(90);
  });

  test('an idle credential with no samples in range counts from its current snapshot', () => {
    const idle = credential({ usedPercent: 20, observedAtMs: NOW - 5 * DAY_MS });
    const series = poolHistory(pool(idle), [], NOW - DAY_MS, NOW);
    expect(series[0]).toEqual({ t: NOW - DAY_MS, v: 80 });
  });

  test('drain counts only positive increments within one window', () => {
    const c = credential();
    const reset = NOW + 3 * DAY_MS;
    const samples = [
      sample({ atMs: NOW - 3 * HOUR_MS, usedPercent: 10, resetAtMs: reset - WEEK_MS }),
      // New window: the drop to 2% is a reset, not negative drain.
      sample({ atMs: NOW - 2.5 * HOUR_MS, usedPercent: 2, resetAtMs: reset }),
      sample({ atMs: NOW - 2.2 * HOUR_MS, usedPercent: 5, resetAtMs: reset }),
      sample({ atMs: NOW - 0.5 * HOUR_MS, usedPercent: 9, resetAtMs: reset }),
      sample({ authId: 'other', atMs: NOW - HOUR_MS, usedPercent: 99 }),
    ];
    const edges = [NOW - 3 * HOUR_MS, NOW - 2 * HOUR_MS, NOW - HOUR_MS, NOW];
    expect(drainBuckets(pool(c), samples, edges)).toEqual([3, 0, 4]);
  });

  test('two session windows of one credential are kept apart by duration', () => {
    const c = credential({ window: 'session', periodMs: 300 * 60 * 1000, usedPercent: 20 });
    const at = (hours: number, minutes: number, usedPercent: number) =>
      sample({
        atMs: NOW - hours * HOUR_MS,
        window: 'session',
        windowMinutes: minutes,
        usedPercent,
      });
    const samples = [at(2, 300, 10), at(2, 1440, 70), at(1, 300, 20), at(1, 1440, 80)];
    const series = poolHistory(pool(c), samples, NOW - 2 * HOUR_MS, NOW);
    expect(valueAt(series, NOW - 1.5 * HOUR_MS)).toBe(90);
    expect(valueAt(series, NOW)).toBe(80);
    const edges = [NOW - 3 * HOUR_MS, NOW - 2 * HOUR_MS, NOW - HOUR_MS, NOW];
    expect(drainBuckets(pool(c), samples, edges)).toEqual([0, 0, 10]);
  });

  test('daily drain buckets follow local midnights across a DST change', () => {
    const previousTz = process.env.TZ;
    process.env.TZ = 'Europe/Vienna';
    try {
      // Oct 25 2026 is 25 hours long in Vienna (clocks fall back at 03:00).
      const now = Date.parse('2026-10-26T10:00:00+01:00');
      const edges = drainEdges(now, 7);
      expect(new Date(edges[0]).toISOString()).toBe('2026-10-19T22:00:00.000Z');
      expect(edges.map((edge) => new Date(edge).getHours())).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
      const c = credential({ resetAtMs: now + DAY_MS });
      const samples = [
        sample({
          atMs: Date.parse('2026-10-24T23:00:00+02:00'),
          usedPercent: 10,
          resetAtMs: now + DAY_MS,
        }),
        // Just after midnight on Oct 25 belongs to Oct 25, not Oct 24.
        sample({
          atMs: Date.parse('2026-10-25T00:30:00+02:00'),
          usedPercent: 13,
          resetAtMs: now + DAY_MS,
        }),
      ];
      expect(drainBuckets(pool(c), samples, edges)).toEqual([0, 0, 0, 0, 0, 3, 0]);
    } finally {
      process.env.TZ = previousTz;
    }
  });
});

test('history normalization keeps well-formed samples, sorted by time', () => {
  const samples = normalizeQuotaHistorySamples({
    samples: [
      {
        at: '2026-10-17T12:00:00Z',
        auth_id: 'b',
        provider: 'Codex',
        window: 'weekly',
        window_minutes: 10080,
        used_percent: 12.5,
        reset_at: '2026-10-20T00:00:00Z',
      },
      {
        at: '2026-10-17T11:00:00Z',
        auth_id: 'a',
        provider: 'claude',
        window: 'session',
        window_minutes: 300,
        used_percent: 3,
        reset_at: '2026-10-17T14:00:00Z',
      },
      { at: 'nope', auth_id: 'c', provider: 'claude', window: 'weekly' },
    ],
  });
  expect(samples.map((entry) => entry.authId)).toEqual(['a', 'b']);
  expect(samples[1]).toMatchObject({ provider: 'codex', usedPercent: 12.5 });
});
