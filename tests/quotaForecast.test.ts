import { describe, expect, test } from 'bun:test';
import type { AuthFileItem } from '../src/types';
import {
  DAY_MS,
  DEFAULT_SLEEP_HOURS,
  FLAT_ACTIVITY,
  HOUR_MS,
  baselineProfile,
  buildPools,
  credentialNow,
  creditsNear,
  drainBuckets,
  drainEdges,
  learnPoolActivity,
  nightHours,
  poolHistory,
  poolResetCredits,
  projectPool,
  runsOutAt,
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

  test('a pool that starts empty does not run out until a reset refills it', () => {
    const c = credential({ periodMs: DAY_MS, usedPercent: 100, resetAtMs: NOW + 12 * HOUR_MS });
    expect(runsOutAt(projectPool(pool(c), NOW, NOW + 11 * HOUR_MS))).toBeNull();
    // Refilled at the reset, then drained at the window pace (100% per 12 hours).
    expect(runsOutAt(projectPool(pool(c), NOW, NOW + 36 * HOUR_MS))).toBe(NOW + 24 * HOUR_MS);
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
      // New window: the drop to 2% is a reset, and those 2% count from its zero.
      sample({ atMs: NOW - 2.5 * HOUR_MS, usedPercent: 2, resetAtMs: reset }),
      sample({ atMs: NOW - 2.2 * HOUR_MS, usedPercent: 5, resetAtMs: reset }),
      sample({ atMs: NOW - 0.5 * HOUR_MS, usedPercent: 9, resetAtMs: reset }),
      sample({ authId: 'other', atMs: NOW - HOUR_MS, usedPercent: 99 }),
    ];
    const edges = [NOW - 3 * HOUR_MS, NOW - 2 * HOUR_MS, NOW - HOUR_MS, NOW];
    expect(drainBuckets(pool(c), samples, edges)).toEqual([5, 0, 4]);
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

  test('hourly drain edges end on the next hour in both repeated DST hours', () => {
    const previousTz = process.env.TZ;
    process.env.TZ = 'Europe/Vienna';
    try {
      for (const now of ['2026-10-25T02:30:00+02:00', '2026-10-25T02:30:00+01:00']) {
        const nowMs = Date.parse(now);
        const edges = drainEdges(nowMs, 1);
        expect(edges[edges.length - 1] - nowMs).toBe(HOUR_MS / 2);
        expect(edges[edges.length - 1] - edges[0]).toBe(24 * HOUR_MS);
      }
    } finally {
      process.env.TZ = previousTz;
    }
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

const withTimeZone = (zone: string, run: () => void) => {
  const previousTz = process.env.TZ;
  process.env.TZ = zone;
  try {
    run();
  } finally {
    process.env.TZ = previousTz;
  }
};

describe('sleep-aware activity', () => {
  test('without history the profile is the sleep baseline and pace falls back to the window', () => {
    const activity = learnPoolActivity(pool(credential()), [], NOW, DEFAULT_SLEEP_HOURS);
    expect(activity.profile).toEqual(baselineProfile(DEFAULT_SLEEP_HOURS));
    expect(activity.profile.slice(0, 8)).toEqual(new Array(8).fill(0));
    expect(activity.profile[12]).toBe(1.5);
    expect(activity.rates.size).toBe(0);
  });

  test('two weeks of night-owl use outweigh the baseline and set the daily rate', () => {
    withTimeZone('UTC', () => {
      const midnight = Date.UTC(2026, 9, 17);
      // 3% at 02:00 every night for 14 nights (one reset id keeps every delta).
      const samples = Array.from({ length: 15 }, (_, day) =>
        sample({
          atMs: midnight - (14 - day) * DAY_MS + 2 * HOUR_MS,
          usedPercent: day * 3,
          resetAtMs: midnight + DAY_MS,
        })
      );
      const c = credential({ resetAtMs: midnight + DAY_MS });
      const activity = learnPoolActivity(pool(c), samples, NOW, DEFAULT_SLEEP_HOURS);
      expect(activity.learnedDays).toBe(14);
      const night = nightHours(activity.profile);
      expect(night[2]).toBe(false);
      expect(activity.profile[2]).toBeGreaterThan(activity.profile[12] * 10);
      const mean = activity.profile.reduce((sum, value) => sum + value, 0) / 24;
      expect(mean).toBeCloseTo(1);
      // The trailing seven days hold seven 3% deltas.
      expect((activity.rates.get('a') ?? 0) * DAY_MS).toBeCloseTo(3);
    });
  });

  test('a busier last day sets the rate; a quieter one keeps the weekly average', () => {
    // 'a': 1% a day for six days, then 10% in the last day. 'b': 2% a day, 1% in the last.
    const steps = (authId: string, perDay: number[]) =>
      perDay.map((_, day) =>
        sample({
          authId,
          atMs: NOW - (perDay.length - 1 - day) * DAY_MS + (day === 0 ? 0 : -HOUR_MS),
          usedPercent: perDay.slice(0, day + 1).reduce((sum, value) => sum + value, 0),
          resetAtMs: NOW + 3 * DAY_MS,
        })
      );
    const samples = [
      ...steps('a', [0, 1, 1, 1, 1, 1, 1, 10]),
      ...steps('b', [0, 2, 2, 2, 2, 2, 3, 1]),
    ];
    const activity = learnPoolActivity(
      pool(credential(), credential({ authId: 'b' })),
      samples,
      NOW,
      DEFAULT_SLEEP_HOURS
    );
    expect((activity.rates.get('a') ?? 0) * DAY_MS).toBeCloseTo(10);
    expect((activity.rates.get('b') ?? 0) * DAY_MS).toBeCloseTo(14 / 7);
  });

  test('a short-lived credential keeps its window pace beside an older one', () => {
    const a = credential({ usedPercent: 2 });
    const b = credential({ authId: 'b' });
    const samples = [
      sample({ atMs: NOW - 2 * HOUR_MS, usedPercent: 0 }),
      sample({ atMs: NOW, usedPercent: 2 }),
      sample({ authId: 'b', atMs: NOW - WEEK_MS, usedPercent: 0 }),
      sample({ authId: 'b', atMs: NOW - DAY_MS, usedPercent: 7 }),
    ];
    const activity = learnPoolActivity(pool(a, b), samples, NOW, DEFAULT_SLEEP_HOURS);
    expect(activity.rates.has('a')).toBe(false);
    expect((activity.rates.get('b') ?? 0) * DAY_MS).toBeCloseTo(1);
  });

  test('under a day of history the rate is the drain so far over its active hours', () => {
    withTimeZone('UTC', () => {
      // 12% used over the six hours to noon, a stretch the sleep baseline partly discounts.
      const samples = [
        sample({ atMs: NOW - 6 * HOUR_MS, usedPercent: 0 }),
        sample({ atMs: NOW, usedPercent: 12 }),
      ];
      const activity = learnPoolActivity(
        pool(credential({ usedPercent: 12 })),
        samples,
        NOW,
        DEFAULT_SLEEP_HOURS
      );
      const activeMs = [6, 7, 8, 9, 10, 11].reduce(
        (sum, hour) => sum + activity.profile[hour] * HOUR_MS,
        0
      );
      expect((activity.rates.get('a') ?? 0) * activeMs).toBeCloseTo(12);
    });
  });

  test('a short span that is mostly night keeps the window pace', () => {
    withTimeZone('UTC', () => {
      // 12% from 01:00 to 04:00, read a second after 04:00: the span is asleep but for that
      // second, so dividing by its active time would claim thousands of percent a day.
      const midnight = Date.UTC(2026, 9, 17);
      const nowMs = midnight + 4 * HOUR_MS + 1000;
      const samples = [
        sample({ atMs: midnight + HOUR_MS, usedPercent: 0 }),
        sample({ atMs: nowMs, usedPercent: 12 }),
      ];
      const activity = learnPoolActivity(
        pool(credential({ usedPercent: 12 })),
        samples,
        nowMs,
        DEFAULT_SLEEP_HOURS
      );
      expect(activity.rates.has('a')).toBe(false);
    });
  });

  test('a session window sampled once per window still learns its drain', () => {
    const period = 5 * HOUR_MS;
    const c = credential({ window: 'session', periodMs: period, resetAtMs: NOW + period });
    // 20% recorded once in each of 14 consecutive five-hour windows (70 hours).
    const samples = Array.from({ length: 14 }, (_, index) =>
      sample({
        atMs: NOW - (13 - index) * period,
        window: 'session',
        windowMinutes: 300,
        usedPercent: 20,
        resetAtMs: NOW - (13 - index) * period + period,
      })
    );
    const activity = learnPoolActivity(pool(c), samples, NOW, DEFAULT_SLEEP_HOURS);
    // 13 new windows counted from zero over 65 covered hours, but five of them land in
    // the last day: 100% a day is faster, so it wins.
    expect((activity.rates.get('a') ?? 0) * DAY_MS).toBeCloseTo(100);
  });

  test('projection is flat while asleep and keeps the daily total', () => {
    withTimeZone('UTC', () => {
      const midnight = Date.UTC(2026, 9, 17);
      const c = credential({ usedPercent: 0, resetAtMs: midnight + 5 * DAY_MS });
      const activity = {
        ...FLAT_ACTIVITY,
        profile: baselineProfile(DEFAULT_SLEEP_HOURS),
        rates: new Map([['a', 24 / DAY_MS]]),
      };
      const series = projectPool(pool(c), midnight, midnight + DAY_MS, activity);
      expect(valueAt(series, midnight + 7.5 * HOUR_MS)).toBe(100);
      expect(valueAt(series, midnight + 8 * HOUR_MS)).toBe(100);
      expect(valueAt(series, midnight + 16 * HOUR_MS)).toBeCloseTo(88);
      expect(valueAt(series, midnight + DAY_MS)).toBeCloseTo(76);
      // "Per hour" stays the daily average.
      expect(summarizePool(pool(c), midnight, activity).pacePerHour).toBeCloseTo(1);
    });
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

test('manual resets: only unused, unexpired ones of the pool, each id once, soonest first', () => {
  const files = [
    file('codex', {}, { id: 'a' }),
    file('codex', {}, { id: 'b' }),
    file('codex', {}, { id: 'c' }),
    file('codex', {}, { id: 'other' }),
  ];
  const at = (ms: number) => new Date(ms).toISOString();
  const credits: Record<string, { id: string; status: string; expiresAt: string }[]> = {
    a: [
      { id: 'a1', status: 'available', expiresAt: at(NOW + 3 * DAY_MS) },
      { id: 'a2', status: 'redeemed', expiresAt: at(NOW + DAY_MS) },
      { id: 'a3', status: 'available', expiresAt: at(NOW - HOUR_MS) },
    ],
    // Another auth file of the same account reports a1 again.
    b: [
      { id: 'b1', status: 'available', expiresAt: at(NOW + DAY_MS) },
      { id: 'b2', status: 'available', expiresAt: 'not a date' },
      { id: 'a1', status: 'available', expiresAt: at(NOW + 3 * DAY_MS) },
    ],
    // Credits without an id stay distinct.
    c: [
      { id: '', status: 'available', expiresAt: at(NOW + 2 * HOUR_MS) },
      { id: '', status: 'available', expiresAt: at(NOW + 2 * DAY_MS) },
    ],
    other: [{ id: 'o1', status: 'available', expiresAt: at(NOW + 2 * DAY_MS) }],
  };
  const codex = {
    ...pool(credential(), credential({ authId: 'b' }), credential({ authId: 'c' })),
    provider: 'codex' as const,
  };
  expect(poolResetCredits(codex, files, (f) => credits[f.id as string], NOW)).toEqual([
    NOW + 2 * HOUR_MS,
    NOW + DAY_MS,
    NOW + 2 * DAY_MS,
    NOW + 3 * DAY_MS,
  ]);
});

test('the tooltip names only manual resets drawn on the chart', () => {
  const toMs = NOW + DAY_MS;
  const tolerance = HOUR_MS;
  const credits = [toMs - HOUR_MS / 2, toMs + HOUR_MS / 2];
  expect(creditsNear(credits, toMs, tolerance, NOW, toMs)).toEqual([toMs - HOUR_MS / 2]);
});
