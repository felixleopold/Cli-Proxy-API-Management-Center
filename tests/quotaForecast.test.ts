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
  firstCredentialEmpty,
  learnActivity,
  nightBands,
  nightHours,
  poolEmpty,
  poolCapacity,
  poolHistory,
  capacityChanges,
  withCapacityTimeline,
  gatewayResetCredits,
  poolResetCredits,
  poolResetEvents,
  resetEventAt,
  resetUseOf,
  projectPool,
  runsOutAt,
  readPoolCredential,
  recentBurn,
  seriesJumps,
  steadyActivity,
  summarizePool,
  valueAt,
} from '../src/features/quota/quotaForecastModel';
import {
  DEFAULT_FORECAST_PREFS,
  parseForecastPrefs,
} from '../src/features/quota/quotaForecastPrefs';
import type {
  LedgerCost,
  PoolCredential,
  ProviderPool,
} from '../src/features/quota/quotaForecastModel';
import { planShareOf } from '../src/features/quota/planMultipliers';
import {
  normalizeQuotaHistorySamples,
  type QuotaHistorySample,
} from '../src/services/api/quotaHistory';
import { normalizeCapacityEntries, type CapacityEntry } from '../src/services/api/capacityHistory';

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
  share: planShareOf({}, 'weekly'),
  ...overrides,
});

const pool = (...credentials: PoolCredential[]): ProviderPool => ({
  provider: 'claude',
  credentials,
  capacity: credentials.reduce((sum, credential) => sum + credential.share.effective, 0),
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
      expect.objectContaining({ provider: 'codex', capacity: 1 }),
    ]);
  });

  test('Muse pools its weekly window; disabled or signal-less Muse credentials add no pool', () => {
    const muse = file('meta', {
      'Muse-Window-Used-Percent': '70',
      'Muse-Window-Minutes': '300',
      'Muse-Window-Reset-At': unix(NOW + HOUR_MS),
      'Muse-Weekly-Used-Percent': '35',
      'Muse-Weekly-Reset-At': unix(NOW + 2 * DAY_MS),
    });
    expect(buildPools([muse])).toEqual([
      {
        provider: 'meta',
        capacity: 1,
        credentials: [
          expect.objectContaining({
            window: 'weekly',
            periodMs: WEEK_MS,
            usedPercent: 35,
            resetAtMs: NOW + 2 * DAY_MS,
          }),
        ],
      },
    ]);
    expect(buildPools([{ ...muse, disabled: true }, file('meta', {})])).toEqual([]);
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
    // In plan multipliers: 1× each, so 1% of a window is 0.01×.
    expect(summary.remaining).toBeCloseTo(1.52);
    expect(summary.capacity).toBe(2);
    expect(summary.pacePerHour).toBeCloseTo(0.005);
    expect(summary.nextReset?.atMs).toBe(NOW + 3 * DAY_MS);
    // By the reset another 72h at 0.5%/h is used: 48 + 36.
    expect(summary.nextReset?.restore).toBeCloseTo(0.84);
  });

  test('projection declines at pace, floors at zero and jumps back to full at each reset', () => {
    // 50% used one day in: 50/24 % per hour, empty one day from now.
    const c = credential({ usedPercent: 50, resetAtMs: NOW + 6 * DAY_MS });
    const series = projectPool(pool(c), NOW, NOW + 8 * DAY_MS);
    expect(valueAt(series, NOW)).toBeCloseTo(0.5);
    expect(valueAt(series, NOW + 12 * HOUR_MS)).toBeCloseTo(0.25);
    expect(valueAt(series, NOW + 3 * DAY_MS)).toBe(0);
    expect(valueAt(series, NOW + 6 * DAY_MS)).toBe(1);
    expect(valueAt(series, NOW + 6.5 * DAY_MS)).toBeCloseTo(0.75);
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
    expect(valueAt(series, NOW - 1.5 * DAY_MS)).toBe(0.4);
    expect(valueAt(series, NOW - 0.5 * DAY_MS)).toBe(1);
    expect(valueAt(series, NOW)).toBe(0.9);
  });

  test('a newly added credential joins the pool without hiding earlier history', () => {
    const old = credential({ usedPercent: 30, observedAtMs: NOW });
    const added = credential({ authId: 'b', usedPercent: 0, observedAtMs: NOW - HOUR_MS });
    const samples = [sample({ atMs: NOW - 2 * DAY_MS, usedPercent: 20 })];
    const series = poolHistory(pool(old, added), samples, NOW - 3 * DAY_MS, NOW);
    expect(series[0].t).toBe(NOW - 2 * DAY_MS);
    expect(valueAt(series, NOW - DAY_MS)).toBe(0.8);
    expect(valueAt(series, NOW - 0.5 * HOUR_MS)).toBeCloseTo(1.8);
  });

  test('an idle credential with no samples in range counts from its current snapshot', () => {
    const idle = credential({ usedPercent: 20, observedAtMs: NOW - 5 * DAY_MS });
    const series = poolHistory(pool(idle), [], NOW - DAY_MS, NOW);
    expect(series[0]).toEqual({ t: NOW - DAY_MS, v: 0.8 });
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
    expect(drainBuckets(pool(c), samples, edges)).toEqual([0.05, 0, 0.04]);
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
    expect(valueAt(series, NOW - 1.5 * HOUR_MS)).toBe(0.9);
    expect(valueAt(series, NOW)).toBe(0.8);
    const edges = [NOW - 3 * HOUR_MS, NOW - 2 * HOUR_MS, NOW - HOUR_MS, NOW];
    expect(drainBuckets(pool(c), samples, edges)).toEqual([0, 0, 0.1]);
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
      expect(drainBuckets(pool(c), samples, edges)).toEqual([0, 0, 0, 0, 0, 0.03, 0]);
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
      expect(valueAt(series, midnight + 7.5 * HOUR_MS)).toBe(1);
      expect(valueAt(series, midnight + 8 * HOUR_MS)).toBe(1);
      expect(valueAt(series, midnight + 16 * HOUR_MS)).toBeCloseTo(0.88);
      expect(valueAt(series, midnight + DAY_MS)).toBeCloseTo(0.76);
      // "Per hour" stays the daily average.
      expect(summarizePool(pool(c), midnight, activity).pacePerHour).toBeCloseTo(0.01);
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

test('gateway-cached reset credits keep valid entries only', () => {
  const claude = file(
    'claude',
    {},
    {
      quota_planning: {
        reset_credits: [
          { id: 'grant-1', expires_at: new Date(NOW + HOUR_MS).toISOString() },
          { id: 'grant-2' },
          'bogus',
        ],
      },
    }
  );
  expect(gatewayResetCredits(claude)).toEqual([
    { id: 'grant-1', status: 'available', expiresAt: new Date(NOW + HOUR_MS).toISOString() },
  ]);
  expect(gatewayResetCredits(file('claude', {}))).toEqual([]);
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
      expect(valueAt(low, NOW)).toBe(0.5);
      expect(valueAt(high, NOW)).toBe(0.5);
      expect(spread(NOW + 2 * DAY_MS)).toBeGreaterThan(spread(NOW + DAY_MS));
    });
  });

  test('without a measured rate the range is the window pace ±40%', () => {
    // 0.5% an hour so far, as in the summary test.
    const c = credential({ usedPercent: 48, resetAtMs: NOW + 3 * DAY_MS });
    const at = (scenario: 'busy' | 'quiet') =>
      valueAt(projectPool(pool(c), NOW, NOW + DAY_MS, FLAT_ACTIVITY, scenario), NOW + 10 * HOUR_MS);
    expect(at('busy')).toBeCloseTo((52 - 7) / 100);
    expect(at('quiet')).toBeCloseTo((52 - 3) / 100);
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

  test('a credential blocked at its cap is rationed relative to the cap, not to 100%', () => {
    withTimeZone('UTC', () => {
      // 10% a day up to 36%, then held at a 40% cap for the last three days.
      const used = [0, 10, 20, 30, 36];
      const samples = [
        ...used.map((usedPercent, day) => sample({ atMs: NOW - (7 - day) * DAY_MS, usedPercent })),
        sample({ atMs: NOW - 2 * DAY_MS, usedPercent: 40 }),
        sample({ atMs: NOW - HOUR_MS, usedPercent: 40 }),
      ];
      const capped = credential({
        usedPercent: 40,
        share: planShareOf({ usageCapPercent: 40 }, 'weekly'),
      });
      const activity = learnActivity([pool(capped)], samples, NOW, DEFAULT_SLEEP_HOURS);
      // Rationed from 34% (85% of the cap): 36% over four days, not 40% over seven.
      const drained = used
        .slice(1)
        .reduce(
          (sum, value, day) => sum + (value - used[day]) * decay(NOW - (6 - day) * DAY_MS),
          0
        );
      const activeMs = decayedActiveMs(activity.profile, NOW - 7 * DAY_MS, NOW - 3 * DAY_MS);
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
    expect(buildPools([live, quiet])[0].capacity).toBe(1);
    const [codex] = buildPools([live, quiet], history);
    expect(codex.capacity).toBe(2);
    expect(codex.credentials[1]).toEqual({
      authId: 'codex-2',
      window: 'weekly',
      periodMs: WEEK_MS,
      usedPercent: 40,
      resetAtMs: NOW + 3 * DAY_MS,
      observedAtMs: NOW - HOUR_MS,
      share: planShareOf({}, 'weekly'),
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

  test('ledger calibration is in base plans, so equal cost drains a bigger plan less', () => {
    withTimeZone('UTC', () => {
      const workHours = [9, 10, 11, 12, 13, 14, 15, 16];
      // $1 an hour each on Oct 4–8: 0.5% an hour of a 1× plan, 0.05% of a 10× plan.
      const spell = (authId: string, perHour: number) => {
        const samples = [sample({ authId, atMs: Date.UTC(2026, 9, 4, 9), usedPercent: 0 })];
        const ledger: LedgerCost[] = [];
        [4, 5, 6, 7, 8].forEach((day) =>
          workHours.forEach((hour) => {
            const hourMs = Date.UTC(2026, 9, day, hour);
            ledger.push({ hourMs, provider: 'claude', authId, costUsd: 1 });
            samples.push(
              sample({ authId, atMs: hourMs + HOUR_MS, usedPercent: samples.length * perHour })
            );
          })
        );
        return { samples, ledger };
      };
      const a = spell('a', 0.5);
      const b = spell('b', 0.05);
      const unequal = pool(
        credential({ usedPercent: 20 }),
        credential({
          authId: 'b',
          usedPercent: 2,
          share: planShareOf({ planMultiplier: 10 }, 'weekly'),
        })
      );
      const activity = learnActivity(
        [unequal],
        [...a.samples, ...b.samples],
        NOW,
        DEFAULT_SLEEP_HOURS,
        [...a.ledger, ...b.ledger]
      );
      const rateA = activity.rates.get('a') ?? 0;
      const rateB = activity.rates.get('b') ?? 0;
      // Same cost, a tenth of the percent on the 10× plan: the same base-plan pace.
      expect(rateA).toBeGreaterThan(0);
      expect(rateA / rateB).toBeCloseTo(10);
      // Alone, 'a' calibrates to the same pace: the 10× plan does not inflate it.
      const alone = learnActivity(
        [pool(credential({ usedPercent: 20 }))],
        a.samples,
        NOW,
        DEFAULT_SLEEP_HOURS,
        a.ledger
      );
      expect(rateA / (alone.rates.get('a') ?? 0)).toBeCloseTo(1);
    });
  });

  test('heavy unattributed cost before the first sample does not raise the pace', () => {
    withTimeZone('UTC', () => {
      const workHours = [9, 10, 11, 12, 13, 14, 15, 16];
      // From Oct 12: 0.5% per working hour against $2 an hour, 4% a day.
      const samples = [sample({ atMs: Date.UTC(2026, 9, 12, 9), usedPercent: 0 })];
      for (let day = 12; day <= 16; day += 1) {
        workHours.forEach((hour) =>
          samples.push(
            sample({ atMs: Date.UTC(2026, 9, day, hour + 1), usedPercent: samples.length * 0.5 })
          )
        );
      }
      // Imported before any sample: ten times the cost, maybe not even this pool's.
      const ledger = ledgerRows('claude', workHours, (hourMs) =>
        hourMs < Date.UTC(2026, 9, 12) ? 20 : 2
      );
      const activity = learnActivity(
        [pool(credential({ usedPercent: 20 }))],
        samples,
        NOW,
        DEFAULT_SLEEP_HOURS,
        ledger
      );
      expect((activity.rates.get('a') ?? 0) * DAY_MS).toBeCloseTo(4, 0);
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

describe('pool cards', () => {
  // Window opened 4 days before NOW, so the window pace is usedPercent / 4 per day.
  const draining = credential({ authId: 'a', usedPercent: 80 });
  const slow = credential({ authId: 'b', usedPercent: 10 });
  const dry = credential({ authId: 'c', usedPercent: 100 });
  const drainSamples = [
    sample({ atMs: NOW - 4 * HOUR_MS, usedPercent: 10 }),
    sample({ atMs: NOW - 2 * HOUR_MS, usedPercent: 16 }),
    sample({ atMs: NOW - HOUR_MS / 2, usedPercent: 19 }),
  ];

  test('burn rate is the pooled multiplier drained per hour in the chosen window', () => {
    const c = credential({ usedPercent: 19 });
    expect(recentBurn(pool(c), drainSamples, NOW, 3)).toBeCloseTo(0.03);
    expect(recentBurn(pool(c), drainSamples, NOW, 1)).toBeCloseTo(0.03);
    expect(recentBurn(pool(c), drainSamples, NOW, 6)).toBeCloseTo(0.015);
  });

  test('"same as now" keeps the recent burn while awake and stays flat while asleep', () => {
    withTimeZone('UTC', () => {
      const c = credential({ usedPercent: 20 });
      // 6% over the last 3 hours: 2% an hour.
      const samples = [
        sample({ atMs: NOW - 3 * HOUR_MS, usedPercent: 14 }),
        sample({ atMs: NOW, usedPercent: 20 }),
      ];
      const learned = { ...FLAT_ACTIVITY, sleep: DEFAULT_SLEEP_HOURS };
      const steady = steadyActivity([pool(c)], samples, NOW, 3, learned);
      const series = projectPool(pool(c), NOW, NOW + DAY_MS, steady);
      expect(valueAt(series, NOW + 6 * HOUR_MS)).toBeCloseTo(0.68);
      // Awake 12:00 to midnight, then asleep until 08:00.
      expect(valueAt(series, NOW + 12 * HOUR_MS)).toBeCloseTo(0.56);
      expect(valueAt(series, NOW + 20 * HOUR_MS)).toBeCloseTo(0.56);
    });
  });

  test('the first account to run dry is the next one before its reset', () => {
    const first = firstCredentialEmpty(pool(slow, draining), NOW);
    expect(first?.authId).toBe('a');
    expect(Math.abs((first?.atMs ?? 0) - (NOW + DAY_MS))).toBeLessThan(1000);
    expect(firstCredentialEmpty(pool(slow), NOW)).toBeNull();
  });

  test('an account already dry is the first empty one, at now', () => {
    expect(firstCredentialEmpty(pool(slow, draining, dry), NOW)).toEqual({
      authId: 'c',
      atMs: NOW,
    });
  });

  test('"same as now" without history keeps the window pace instead of a measured zero', () => {
    const learned = { ...FLAT_ACTIVITY, sleep: DEFAULT_SLEEP_HOURS };
    const steady = steadyActivity([pool(draining)], [], NOW, 3, learned);
    expect(steady.rates.has('a')).toBe(false);
    expect(poolEmpty(pool(draining), NOW, NOW + 7 * DAY_MS, steady).kind).toBe('at');
  });

  test('pool empty reads a time, empty now, not before reset, or not by the view end', () => {
    const at = poolEmpty(pool(draining), NOW, NOW + 7 * DAY_MS);
    expect(at.kind).toBe('at');
    expect(at.kind === 'at' && Math.abs(at.atMs - (NOW + DAY_MS))).toBeLessThan(1000);
    expect(poolEmpty(pool(dry), NOW, NOW + DAY_MS)).toEqual({ kind: 'now' });
    // The view ends before the reset, and the pool lasts past that reset.
    expect(poolEmpty(pool(slow), NOW, NOW + DAY_MS)).toEqual({ kind: 'not-before-reset' });
    expect(poolEmpty(pool(slow), NOW, NOW + 14 * DAY_MS)).toEqual({
      kind: 'not-by',
      atMs: NOW + 14 * DAY_MS,
    });
  });

  test('only upward jumps at least minDelta are labelled', () => {
    const series = [
      { t: 0, v: 1 },
      { t: 5, v: 0.5 },
      { t: 5, v: 1.2 },
      { t: 6, v: 1.19 },
      { t: 8, v: 1.19 },
      { t: 8, v: 1.2 },
      { t: 9, v: 1.2 },
      { t: 9, v: 0.9 },
    ];
    expect(seriesJumps(series, 0.05)).toEqual([{ t: 5, from: 0.5, to: 1.2 }]);
  });

  test('stored preferences keep valid fields over the defaults', () => {
    expect(parseForecastPrefs(null)).toEqual(DEFAULT_FORECAST_PREFS);
    expect(
      parseForecastPrefs({ collapsed: { meta: false, claude: 'yes' }, burnHours: 6, future: 'x' })
    ).toEqual({
      collapsed: { claude: false, codex: false, meta: false },
      burnHours: 6,
      future: 'usual',
    });
  });
});

describe('reset events', () => {
  test('names the accounts behind each recorded and projected reset, with how much they used', () => {
    const half = planShareOf({ reserveWeeklyPercent: 50 }, 'weekly');
    const a = credential({ authId: 'a', usedPercent: 10, resetAtMs: NOW + 2 * DAY_MS });
    const b = credential({
      authId: 'b',
      usedPercent: 0,
      resetAtMs: NOW + 2 * DAY_MS + 30_000,
      share: half,
    });
    const samples = [
      // a's previous window: 96% used just before it reset a day ago.
      sample({ authId: 'a', atMs: NOW - 3 * DAY_MS, usedPercent: 60, resetAtMs: NOW - DAY_MS }),
      sample({
        authId: 'a',
        atMs: NOW - DAY_MS - HOUR_MS,
        usedPercent: 96,
        resetAtMs: NOW - DAY_MS,
      }),
      sample({ authId: 'a', atMs: NOW - HOUR_MS, usedPercent: 10, resetAtMs: NOW + 2 * DAY_MS }),
    ];
    // 1% of the window per hour: a adds 48% by its reset; b's 50% share caps it.
    const activity = {
      ...FLAT_ACTIVITY,
      rates: new Map([
        ['a', 1 / HOUR_MS],
        ['b', 3 / HOUR_MS],
      ]),
    };
    const events = poolResetEvents(
      pool(a, b),
      samples,
      NOW - 7 * DAY_MS,
      NOW,
      NOW + 3 * DAY_MS,
      activity
    );

    expect(events).toHaveLength(2);
    const [recorded, projected] = events;
    expect(recorded).toMatchObject({ atMs: NOW - DAY_MS, projected: false });
    expect(recorded.accounts).toEqual([{ authId: 'a', usedPercent: 96, capPercent: 100 }]);
    expect(recorded.restore).toBeCloseTo(0.96);
    expect(resetUseOf(recorded.utilization)).toBe('full');

    // a and b reset 30 s apart: one event.
    expect(projected.projected).toBe(true);
    expect(projected.accounts.map((account) => account.authId)).toEqual(['a', 'b']);
    expect(projected.accounts[0].usedPercent).toBeCloseTo(58);
    expect(projected.accounts[1].usedPercent).toBe(50);
    // (58 + 50) used of (100 + 50) ours.
    expect(projected.utilization).toBeCloseTo(108 / 150);
    expect(resetUseOf(projected.utilization)).toBe('partial');
    expect(resetEventAt(events, NOW + 2 * DAY_MS + 20_000)).toBe(projected);
    expect(resetEventAt(events, NOW)).toBeNull();
  });

  test('a barely used reset reads as low, and fully reserved accounts are left out', () => {
    const idle = credential({ authId: 'a', usedPercent: 5, resetAtMs: NOW + HOUR_MS });
    const reserved = credential({
      authId: 'r',
      usedPercent: 40,
      resetAtMs: NOW + HOUR_MS,
      share: planShareOf({ reserveWeeklyPercent: 100 }, 'weekly'),
    });
    const [event] = poolResetEvents(pool(idle, reserved), [], NOW, NOW, NOW + DAY_MS, {
      ...FLAT_ACTIVITY,
      rates: new Map([['a', 0]]),
    });
    expect(event.accounts.map((account) => account.authId)).toEqual(['a']);
    expect(resetUseOf(event.utilization)).toBe('low');
  });
});

describe('capacity timeline', () => {
  const entry = (overrides: Partial<CapacityEntry>): CapacityEntry => ({
    atMs: NOW - 5 * DAY_MS,
    authId: 'a',
    provider: 'claude',
    label: 'a@example.com',
    nickname: '',
    active: true,
    retired: false,
    plan: 'pro',
    weightFiveHour: 1,
    weightWeekly: 1,
    shareFiveHourPercent: 100,
    shareWeeklyPercent: 100,
    lender: '',
    lenderGroup: false,
    reason: 'added',
    source: 'observed',
    ...overrides,
  });

  // An Ultra (10× weekly) retired a day ago beside a 1× account that stays.
  const retiredUltra = () => {
    const entries = [
      entry({}),
      entry({ authId: 'u', nickname: 'Ultra', weightWeekly: 10, weightFiveHour: 20 }),
      entry({ authId: 'u', nickname: 'Ultra', atMs: NOW - DAY_MS, active: false, retired: true }),
    ].map((value, index) => (index === 2 ? { ...value, reason: 'retired' } : value));
    const samples = [
      sample({ atMs: NOW - 2 * DAY_MS, usedPercent: 20 }),
      sample({ authId: 'u', atMs: NOW - 2 * DAY_MS, usedPercent: 40 }),
    ];
    const current = credential({ usedPercent: 30 });
    return { entries, samples, drawn: withCapacityTimeline(pool(current), entries, samples) };
  };

  test('a retired credential is drawn while it was active, and the capacity steps down', () => {
    const { entries, samples, drawn } = retiredUltra();
    expect(drawn.credentials.map((c) => c.authId)).toEqual(['a', 'u']);
    expect(drawn.capacity).toBe(1);
    const history = poolHistory(drawn, samples, NOW - 3 * DAY_MS, NOW);
    expect(valueAt(history, NOW - 1.5 * DAY_MS)).toBeCloseTo(0.8 + 6);
    expect(valueAt(history, NOW - 0.5 * DAY_MS)).toBeCloseTo(0.8);
    expect(valueAt(history, NOW)).toBeCloseTo(0.7);
    const capacity = poolCapacity(drawn, samples, NOW - 3 * DAY_MS, NOW) ?? [];
    expect(valueAt(capacity, NOW - 3 * DAY_MS)).toBe(11);
    expect(valueAt(capacity, NOW - 0.5 * DAY_MS)).toBe(1);
    expect(capacityChanges(drawn, entries, NOW - 3 * DAY_MS, NOW)).toEqual([
      {
        atMs: NOW - DAY_MS,
        authId: 'u',
        name: 'Ultra',
        kind: 'retired',
        effective: 0,
        delta: -10,
        reason: 'retired',
      },
    ]);
  });

  test('a retired credential projects no further resets', () => {
    const { samples, drawn } = retiredUltra();
    const events = poolResetEvents(drawn, samples, NOW, NOW, NOW + 5 * DAY_MS);
    expect(events.map((event) => event.accounts.map((account) => account.authId))).toEqual([['a']]);
  });

  test('each sample reads at the plan weight in effect when it was taken', () => {
    // Upgraded 1× → 5× a day ago; the provider rescaled the used percent at the next sample.
    const entries = [
      entry({ atMs: NOW - 3 * DAY_MS }),
      entry({ atMs: NOW - DAY_MS, plan: 'max', weightWeekly: 5, reason: 'plan pro → max' }),
    ];
    const samples = [
      sample({ atMs: NOW - 2 * DAY_MS, usedPercent: 50 }),
      sample({ atMs: NOW - DAY_MS + 2 * HOUR_MS, usedPercent: 10 }),
    ];
    const current = credential({
      usedPercent: 10,
      observedAtMs: NOW - DAY_MS + 2 * HOUR_MS,
      share: planShareOf({ planWeightWeekly: 5 }, 'weekly'),
    });
    const drawn = withCapacityTimeline(pool(current), entries, samples);
    const history = poolHistory(drawn, samples, NOW - 3 * DAY_MS, NOW);
    expect(valueAt(history, NOW - 1.5 * DAY_MS)).toBeCloseTo(0.5);
    // The last sample before the change keeps the old weight until the next one arrives.
    expect(valueAt(history, NOW - DAY_MS + HOUR_MS)).toBeCloseTo(0.5);
    expect(valueAt(history, NOW - DAY_MS + 3 * HOUR_MS)).toBeCloseTo(4.5);
    const capacity = poolCapacity(drawn, samples, NOW - 3 * DAY_MS, NOW) ?? [];
    expect(valueAt(capacity, NOW - 1.5 * DAY_MS)).toBe(1);
    expect(valueAt(capacity, NOW - 0.5 * DAY_MS)).toBe(5);
    expect(capacityChanges(drawn, entries, NOW - 3 * DAY_MS, NOW)).toMatchObject([
      { kind: 'changed', effective: 5, delta: 4, reason: 'plan pro → max' },
    ]);
  });

  test('without timeline entries the pool and its history are as before', () => {
    const current = pool(credential({ usedPercent: 30 }));
    expect(withCapacityTimeline(current, [], [])).toBe(current);
    expect(poolCapacity(current, [], NOW - DAY_MS, NOW)).toBeNull();
  });

  test('entries are normalized, sorted by time, and malformed ones dropped', () => {
    const raw = (at: number, extra = {}) => ({
      at_ms: at,
      auth_id: 'a',
      provider: 'Claude',
      active: true,
      weight_five_hour: 20,
      weight_weekly: 10,
      share_five_hour_percent: 100,
      share_weekly_percent: 70,
      source: 'backfill',
      ...extra,
    });
    const entries = normalizeCapacityEntries({
      entries: [raw(2), raw(1), raw(3, { weight_weekly: 'x' }), null],
    });
    expect(entries.map((value) => value.atMs)).toEqual([1, 2]);
    expect(entries[0]).toMatchObject({ provider: 'claude', source: 'backfill', weightWeekly: 10 });
  });
});
