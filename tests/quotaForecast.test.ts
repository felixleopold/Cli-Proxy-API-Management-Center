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
  learnActivity,
  nightBands,
  nightHours,
  poolHistory,
  poolResetCredits,
  projectPool,
  runsOutAt,
  readPoolCredential,
  summarizePool,
  valueAt,
} from '../src/features/quota/quotaForecastModel';
import type {
  LedgerCost,
  PoolCredential,
  ProviderPool,
} from '../src/features/quota/quotaForecastModel';
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

/** The pace weight: a 3-day half-life back from NOW. */
const decay = (t: number) => 2 ** ((t - NOW) / (3 * DAY_MS));

/** Activity-weighted time over whole UTC hours in [fromMs, toMs), each decayed at its midpoint. */
const decayedActiveMs = (profile: number[], fromMs: number, toMs: number) => {
  let sum = 0;
  for (let t = fromMs; t < toMs; t += HOUR_MS) {
    sum += profile[new Date(t).getUTCHours()] * HOUR_MS * decay(t + HOUR_MS / 2);
  }
  return sum;
};

describe('sleep-aware activity', () => {
  test('without history the profile is the sleep baseline and pace falls back to the window', () => {
    const activity = learnActivity([pool(credential())], [], NOW, DEFAULT_SLEEP_HOURS);
    expect(activity.profile).toEqual(baselineProfile(DEFAULT_SLEEP_HOURS));
    expect(activity.profile.slice(0, 8)).toEqual(new Array(8).fill(0));
    expect(activity.profile[12]).toBe(1.5);
    expect(activity.rates.size).toBe(0);
  });

  test('learned night-owl sleep is clipped to the baseline', () => {
    withTimeZone('UTC', () => {
      // 0.25% in every hour from 12:00 to 04:00 for two weeks: quiet 04:00–12:00.
      const start = Date.UTC(2026, 9, 3);
      const samples: QuotaHistorySample[] = [];
      for (let t = start + HOUR_MS / 2; t <= NOW; t += HOUR_MS) {
        const hour = new Date(t).getUTCHours();
        if (hour >= 4 && hour < 12) continue;
        samples.push(sample({ atMs: t, usedPercent: samples.length * 0.25 }));
      }
      const activity = learnActivity([pool(credential())], samples, NOW, DEFAULT_SLEEP_HOURS);
      // Sleep starts later, but never runs past the baseline's 08:00.
      expect(activity.sleep).toEqual({ startHour: 4, endHour: 8 });
      const night = nightHours(activity.sleep);
      expect(night[2]).toBe(false);
      expect(night[6]).toBe(true);
      expect(night[10]).toBe(false);
      expect(activity.profile[6]).toBe(0);
      // A quiet morning is slower, not asleep.
      expect(activity.profile[10]).toBeGreaterThan(0);
      expect(activity.profile[2]).toBeGreaterThan(0.5);
      const mean = activity.profile.reduce((sum, value) => sum + value, 0) / 24;
      expect(mean).toBeCloseTo(1);
      // Sixteen 0.25% deltas a day.
      expect((activity.rates.get('a') ?? 0) * DAY_MS).toBeCloseTo(4, 0);
    });
  });

  test('a one-day spike raises the pace without setting it', () => {
    withTimeZone('UTC', () => {
      // 1% a day for six days, then 10% in the last day.
      const perDay = [0, 1, 1, 1, 1, 1, 1, 10];
      const samples = perDay.map((_, day) =>
        sample({
          atMs: NOW - (perDay.length - 1 - day) * DAY_MS + (day === 0 ? 0 : -HOUR_MS),
          usedPercent: perDay.slice(0, day + 1).reduce((sum, value) => sum + value, 0),
        })
      );
      const activity = learnActivity([pool(credential())], samples, NOW, DEFAULT_SLEEP_HOURS);
      const perDayRate = (activity.rates.get('a') ?? 0) * DAY_MS;
      // Above the steady 1%, well below the spike's 10% a max() rule would take.
      expect(perDayRate).toBeGreaterThan(2);
      expect(perDayRate).toBeLessThan(5);
    });
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
    const activity = learnActivity([pool(a, b)], samples, NOW, DEFAULT_SLEEP_HOURS);
    expect(activity.rates.has('a')).toBe(false);
    // 7% in a week, recorded a day ago: recent use outweighs the plain 1% a day.
    expect((activity.rates.get('b') ?? 0) * DAY_MS).toBeGreaterThan(1);
  });

  test('under a day of history the rate is the drain so far over its active hours', () => {
    withTimeZone('UTC', () => {
      // 12% used over the six hours to noon, a stretch the sleep baseline partly discounts.
      const samples = [
        sample({ atMs: NOW - 6 * HOUR_MS, usedPercent: 0 }),
        sample({ atMs: NOW, usedPercent: 12 }),
      ];
      const activity = learnActivity(
        [pool(credential({ usedPercent: 12 }))],
        samples,
        NOW,
        DEFAULT_SLEEP_HOURS
      );
      const activeMs = decayedActiveMs(activity.profile, NOW - 6 * HOUR_MS, NOW);
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
      const activity = learnActivity(
        [pool(credential({ usedPercent: 12 }))],
        samples,
        nowMs,
        DEFAULT_SLEEP_HOURS
      );
      expect(activity.rates.has('a')).toBe(false);
    });
  });

  test('a session window sampled once per window still learns its drain', () => {
    withTimeZone('UTC', () => {
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
      const activity = learnActivity([pool(c)], samples, NOW, DEFAULT_SLEEP_HOURS);
      // 13 new windows, each counted from zero, over the 65 covered hours.
      const used = samples.slice(1).reduce((sum, { atMs }) => sum + 20 * decay(atMs), 0);
      const activeMs = decayedActiveMs(activity.profile, NOW - 13 * period, NOW);
      expect((activity.rates.get('a') ?? 0) * DAY_MS).toBeCloseTo((used / activeMs) * DAY_MS);
    });
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

/** Cumulative 0.1% samples at half past each active UTC hour, from Oct 3 to NOW. */
const hourlyUse = (authId: string, activeHours: number[]): QuotaHistorySample[] => {
  const samples: QuotaHistorySample[] = [];
  for (let t = Date.UTC(2026, 9, 3) + HOUR_MS / 2; t <= NOW; t += HOUR_MS) {
    if (!activeHours.includes(new Date(t).getUTCHours())) continue;
    samples.push(sample({ authId, atMs: t, usedPercent: samples.length * 0.1 }));
  }
  return samples;
};

describe('likely range and shared sleep', () => {
  test('busy and quiet edges bracket the projection and widen with time', () => {
    withTimeZone('UTC', () => {
      // One change a day of 2..10%, nine measurable days.
      const perDay = [0, 2, 4, 6, 8, 10, 2, 4, 6, 4];
      const samples = perDay.map((_, day) =>
        sample({
          atMs: NOW - (10 - day) * DAY_MS + 2 * HOUR_MS,
          usedPercent: perDay.slice(0, day + 1).reduce((sum, value) => sum + value, 0),
          resetAtMs: NOW + 6 * DAY_MS,
        })
      );
      const c = credential({ usedPercent: 50, resetAtMs: NOW + 6 * DAY_MS });
      const activity = learnActivity([pool(c)], samples, NOW, DEFAULT_SLEEP_HOURS);
      const expected = activity.rates.get('a') ?? 0;
      const range = activity.ranges.get('a');
      expect(range?.busy).toBeGreaterThan(expected);
      expect(range?.quiet).toBeLessThan(expected);

      const end = NOW + 3 * DAY_MS;
      const [low, mid, high] = (['busy', 'expected', 'quiet'] as const).map((scenario) =>
        projectPool(pool(c), NOW, end, activity, scenario)
      );
      const spread = (t: number) => (valueAt(high, t) ?? 0) - (valueAt(low, t) ?? 0);
      for (const t of [NOW + DAY_MS, NOW + 2 * DAY_MS]) {
        expect(valueAt(high, t)).toBeGreaterThan(valueAt(mid, t) ?? 0);
        expect(valueAt(mid, t)).toBeGreaterThan(valueAt(low, t) ?? 0);
      }
      expect(valueAt(low, NOW)).toBe(50);
      expect(valueAt(high, NOW)).toBe(50);
      expect(spread(NOW + 2 * DAY_MS)).toBeGreaterThan(spread(NOW + DAY_MS));
    });
  });

  test('without a measured rate the range is the window pace ±40%', () => {
    // 0.5% an hour so far, as in the summary test.
    const c = credential({ usedPercent: 48, resetAtMs: NOW + 3 * DAY_MS });
    const at = (scenario: 'busy' | 'quiet') =>
      valueAt(projectPool(pool(c), NOW, NOW + DAY_MS, FLAT_ACTIVITY, scenario), NOW + 10 * HOUR_MS);
    expect(at('busy')).toBeCloseTo(52 - 7);
    expect(at('quiet')).toBeCloseTo(52 - 3);
  });

  test('pace leaves out drain and time spent under 15% remaining', () => {
    withTimeZone('UTC', () => {
      // 15% a day for five days, 12% more, then rationed at 87–88% for the last day.
      const used = [0, 15, 30, 45, 60, 75, 87];
      const samples = [
        ...used.map((usedPercent, day) => sample({ atMs: NOW - (7 - day) * DAY_MS, usedPercent })),
        sample({ atMs: NOW - HOUR_MS, usedPercent: 88 }),
      ];
      const activity = learnActivity(
        [pool(credential({ usedPercent: 88 }))],
        samples,
        NOW,
        DEFAULT_SLEEP_HOURS
      );
      // 87% over six unrationed days, not 88% over seven.
      const drained = used
        .slice(1)
        .reduce(
          (sum, value, day) => sum + (value - used[day]) * decay(NOW - (6 - day) * DAY_MS),
          0
        );
      const activeMs = decayedActiveMs(activity.profile, NOW - 7 * DAY_MS, NOW - DAY_MS);
      expect((activity.rates.get('a') ?? 0) * DAY_MS).toBeCloseTo((drained / activeMs) * DAY_MS);
    });
  });

  test('every provider shares one continuous sleep stretch', () => {
    withTimeZone('UTC', () => {
      // Claude by day, Codex in the evening and once at 02:00; nobody at 13–14.
      const samples = [
        ...hourlyUse('a', [9, 10, 11, 12, 15, 16]),
        ...hourlyUse('b', [2, 17, 18, 19, 20, 21, 22, 23]),
      ];
      const codex = { ...pool(credential({ authId: 'b' })), provider: 'codex' as const };
      const activity = learnActivity(
        [pool(credential()), codex],
        samples,
        NOW,
        DEFAULT_SLEEP_HOURS
      );
      // The 02:00 hour is merged in; the quiet 08:00 and 13–14 are past the baseline, so no sleep.
      expect(activity.sleep).toEqual({ startHour: 0, endHour: 8 });
      expect(activity.profile[2]).toBe(0);
      expect(activity.profile[13]).toBeGreaterThan(0);
      const midnight = Date.UTC(2026, 9, 18);
      expect(nightBands(nightHours(activity.sleep), midnight, midnight + DAY_MS)).toEqual([
        { startMs: midnight, endMs: midnight + 8 * HOUR_MS },
      ]);
    });
  });

  test('use through every night leaves no sleep hours once learned', () => {
    withTimeZone('UTC', () => {
      const allDay = Array.from({ length: 24 }, (_, hour) => hour);
      const activity = learnActivity(
        [pool(credential())],
        hourlyUse('a', allDay),
        NOW,
        DEFAULT_SLEEP_HOURS
      );
      expect(nightHours(activity.sleep).some(Boolean)).toBe(false);
      expect(nightBands(nightHours(activity.sleep), NOW, NOW + DAY_MS)).toEqual([]);
      expect(activity.profile[3]).toBeGreaterThan(0);
    });
  });

  test('a credential without live signals joins its pool from its latest history reading', () => {
    const live = file('codex', {
      'X-Codex-Secondary-Used-Percent': '10',
      'X-Codex-Secondary-Window-Minutes': '10080',
      'X-Codex-Secondary-Reset-At': unix(NOW + DAY_MS),
    });
    const quiet = file('codex', {}, { id: 'codex-2', quota: undefined });
    const history = [
      sample({ authId: 'codex-2', provider: 'codex', atMs: NOW - 2 * HOUR_MS, usedPercent: 30 }),
      sample({ authId: 'codex-2', provider: 'codex', atMs: NOW - HOUR_MS, usedPercent: 40 }),
      sample({
        authId: 'codex-2',
        provider: 'codex',
        atMs: NOW,
        window: 'session',
        windowMinutes: 300,
        usedPercent: 90,
      }),
    ];
    expect(buildPools([live, quiet])[0].capacity).toBe(100);
    const [codex] = buildPools([live, quiet], history);
    expect(codex.capacity).toBe(200);
    expect(codex.credentials[1]).toEqual({
      authId: 'codex-2',
      window: 'weekly',
      periodMs: WEEK_MS,
      usedPercent: 40,
      resetAtMs: NOW + 3 * DAY_MS,
      observedAtMs: NOW - HOUR_MS,
    });
  });
});

describe('usage ledger', () => {
  /** One ledger row per active UTC hour from Oct 3 to NOW, at the cost that hour's day gives. */
  const ledgerRows = (
    provider: string,
    activeHours: number[],
    costOn: (hourMs: number) => number,
    authId = ''
  ): LedgerCost[] => {
    const rows: LedgerCost[] = [];
    for (let hourMs = Date.UTC(2026, 9, 3); hourMs < NOW; hourMs += HOUR_MS) {
      if (activeHours.includes(new Date(hourMs).getUTCHours())) {
        rows.push({ hourMs, provider, authId, costUsd: costOn(hourMs) });
      }
    }
    return rows;
  };

  test('quota percent per dollar from drained hours sets the weekly rate', () => {
    withTimeZone('UTC', () => {
      const workHours = [9, 10, 11, 12, 13, 14, 15, 16];
      // Oct 3–9: 0.5% per working hour, recorded at the end of each hour, against $2 an hour.
      const samples = [sample({ atMs: Date.UTC(2026, 9, 3, 9), usedPercent: 0 })];
      for (let day = 3; day <= 9; day += 1) {
        workHours.forEach((hour) =>
          samples.push(
            sample({
              atMs: Date.UTC(2026, 9, day, hour + 1),
              usedPercent: samples.length * 0.5,
            })
          )
        );
      }
      // No drain recorded since; the ledger shows $4 an hour from Oct 10.
      const ledger = [
        ...ledgerRows('Claude', workHours, (hourMs) => (hourMs < Date.UTC(2026, 9, 10) ? 2 : 4)),
        // API-key traffic drains no subscription quota.
        ...ledgerRows('claude', workHours, () => 50, 'claude-api-key'),
      ];
      const c = credential({ usedPercent: 28 });
      const activity = learnActivity([pool(c)], samples, NOW, DEFAULT_SLEEP_HOURS, ledger);
      // 28% over $112 is 0.25% a dollar: 4% a day before Oct 10, 8% since. Recent days weigh more.
      const perDayRate = (activity.rates.get('a') ?? 0) * DAY_MS;
      expect(perDayRate).toBeGreaterThan(6);
      expect(perDayRate).toBeLessThan(8);
      expect((activity.ranges.get('a')?.busy ?? 0) * DAY_MS).toBeGreaterThanOrEqual(perDayRate);

      // Without a ledger the history rate stands: only drain over a week old, decayed.
      const withoutLedger = learnActivity([pool(c)], samples, NOW, DEFAULT_SLEEP_HOURS);
      expect((withoutLedger.rates.get('a') ?? 0) * DAY_MS).toBeLessThan(1);
    });
  });

  test('each credential paces by its own attributed ledger cost', () => {
    withTimeZone('UTC', () => {
      const workHours = [9, 10, 11, 12, 13, 14, 15, 16];
      // 'a' drains 80% on Oct 4–8 at $1 an hour; 'b' drains 80% on Oct 15–16 at $2.50 an hour.
      const spell = (authId: string, days: number[], perHour: number, costUsd: number) => {
        const samples = [sample({ authId, atMs: Date.UTC(2026, 9, days[0], 9), usedPercent: 0 })];
        const ledger: LedgerCost[] = [];
        days.forEach((day) =>
          workHours.forEach((hour) => {
            const hourMs = Date.UTC(2026, 9, day, hour);
            ledger.push({ hourMs, provider: 'claude', authId, costUsd });
            samples.push(
              sample({ authId, atMs: hourMs + HOUR_MS, usedPercent: samples.length * perHour })
            );
          })
        );
        return { samples, ledger };
      };
      const a = spell('a', [4, 5, 6, 7, 8], 2, 1);
      const b = spell('b', [15, 16], 5, 2.5);
      const activity = learnActivity(
        [pool(credential({ usedPercent: 80 }), credential({ authId: 'b', usedPercent: 80 }))],
        [...a.samples, ...b.samples],
        NOW,
        DEFAULT_SLEEP_HOURS,
        [...a.ledger, ...b.ledger]
      );
      // Equal drain, but 'b' spent recently: the rates follow each one's decayed cost.
      const decayedCost = (rows: LedgerCost[]) =>
        rows.reduce((sum, row) => sum + row.costUsd * decay(row.hourMs + HOUR_MS / 2), 0);
      const rateA = (activity.rates.get('a') ?? 0) * DAY_MS;
      const rateB = (activity.rates.get('b') ?? 0) * DAY_MS;
      expect(rateA).toBeGreaterThan(0);
      expect(rateB / rateA).toBeCloseTo(decayedCost(b.ledger) / decayedCost(a.ledger));
    });
  });

  test('unchanged readings keep their cost in the ledger calibration', () => {
    withTimeZone('UTC', () => {
      const workHours = [9, 10, 11, 12, 13, 14, 15, 16];
      // Oct 3–9: hourly samples, but rounding shows 1% only every other working hour, against $2 an hour.
      const samples = [sample({ atMs: Date.UTC(2026, 9, 3, 9), usedPercent: 0 })];
      let used = 0;
      for (let day = 3; day <= 9; day += 1) {
        workHours.forEach((hour, index) => {
          if (index % 2 === 1) used += 1;
          samples.push(sample({ atMs: Date.UTC(2026, 9, day, hour + 1), usedPercent: used }));
        });
      }
      const ledger = ledgerRows('Claude', workHours, () => 2);
      const activity = learnActivity(
        [pool(credential({ usedPercent: used }))],
        samples,
        NOW,
        DEFAULT_SLEEP_HOURS,
        ledger
      );
      // 28% over $112 is 0.25% a dollar, not 0.5% from only the hours the reading moved; $112 last week is 4% a day.
      expect((activity.rates.get('a') ?? 0) * DAY_MS).toBeCloseTo(4, 0);
    });
  });

  test('ledger cost of every forecast provider learns the shared sleep stretch', () => {
    withTimeZone('UTC', () => {
      const allDay = Array.from({ length: 24 }, (_, hour) => hour);
      const ledger = [
        ...ledgerRows('claude', [0, 8, 9, 10, 11, 12, 13, 14], () => 1),
        ...ledgerRows('codex', [15, 16, 17, 18, 19, 20, 21, 22, 23], () => 1),
        // Other providers do not count toward the forecast's day.
        ...ledgerRows('gemini', allDay, () => 1),
      ];
      const activity = learnActivity([], [], NOW, DEFAULT_SLEEP_HOURS, ledger);
      expect(activity.sleep).toEqual({ startHour: 1, endHour: 8 });
      expect(learnActivity([], [], NOW, DEFAULT_SLEEP_HOURS).sleep).toEqual(DEFAULT_SLEEP_HOURS);
      // Office hours leave 17:00–09:00 quiet; that 16-hour run clips to the baseline.
      const officeHours = ledgerRows('claude', [9, 10, 11, 12, 13, 14, 15, 16], () => 1);
      expect(learnActivity([], [], NOW, DEFAULT_SLEEP_HOURS, officeHours).sleep).toEqual(
        DEFAULT_SLEEP_HOURS
      );
    });
  });
});
