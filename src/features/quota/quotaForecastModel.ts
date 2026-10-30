/**
 * Pooled quota forecast.
 *
 * Each credential contributes one window to its provider's pool: the weekly
 * window, or its first window when it has no weekly one. Pools are in plan
 * multipliers (planMultipliers.ts): a credential adds what is left to us of its
 * window, up to its effective multiplier, and refills to that at each reset.
 * Pace and drain stay in percent of the credential's own window. Current state
 * comes from the passive quota signals on GET /credentials; history comes from
 * the backend's quota history samples. Everything here is pure so it can be
 * tested without a browser; QuotaForecast.tsx is layout only.
 */

import type { AuthFileItem, UsageLedgerBucket } from '@/types';
import type { QuotaHistorySample, QuotaHistoryWindow } from '@/services/api/quotaHistory';
import { isRecord } from '@/utils/helpers';
import {
  multiplierTotals,
  planShareOf,
  remainingMultiplier,
  type MultiplierTotals,
  type PlanShare,
} from './planMultipliers';

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export const FORECAST_PROVIDERS = ['claude', 'codex', 'meta'] as const;
export type ForecastProvider = (typeof FORECAST_PROVIDERS)[number];

export const FORECAST_HORIZON_DAYS = [1, 3, 7, 14] as const;
export type ForecastHorizonDays = (typeof FORECAST_HORIZON_DAYS)[number];

export const DRAIN_SPAN_DAYS = [1, 3, 7] as const;
export type DrainSpanDays = (typeof DRAIN_SPAN_DAYS)[number];

/** Same threshold the backend uses to class a window as weekly. */
const WEEKLY_MIN_MINUTES = 6 * 24 * 60;
/** Two resets this close together are the same reset (Codex reset-at can jitter). */
const SAME_RESET_TOLERANCE_MS = 60 * 1000;
/**
 * Pace is used% over the elapsed part of the window. A window that opened
 * minutes ago would turn one request into an absurd hourly rate.
 */
const MIN_PACE_ELAPSED_MS = HOUR_MS;

export interface PoolCredential {
  authId: string;
  window: QuotaHistoryWindow;
  periodMs: number;
  /** 0..100, as of the snapshot. */
  usedPercent: number;
  resetAtMs: number;
  observedAtMs: number | null;
  share: PlanShare;
}

export interface ProviderPool {
  provider: ForecastProvider;
  credentials: PoolCredential[];
  /** Σ effective multiplier of the credentials. */
  capacity: number;
}

export interface SeriesPoint {
  t: number;
  v: number;
}

const isForecastProvider = (value: string): value is ForecastProvider =>
  (FORECAST_PROVIDERS as readonly string[]).includes(value);

const parseNumber = (value: unknown): number | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
};

const parseUnixMs = (value: unknown): number | null => {
  const seconds = parseNumber(value);
  return seconds !== null && seconds > 0 ? seconds * 1000 : null;
};

/** Header names are canonicalized by the backend; match case-insensitively anyway. */
const readSignals = (file: AuthFileItem): ((name: string) => unknown) | null => {
  const quota = file.quota;
  if (!isRecord(quota) || !isRecord(quota.signals)) return null;
  const byLowerName = new Map(
    Object.entries(quota.signals).map(([key, value]) => [key.toLowerCase(), value])
  );
  return (name) => byLowerName.get(name.toLowerCase());
};

const readObservedAtMs = (file: AuthFileItem): number | null => {
  const quota = file.quota;
  if (!isRecord(quota) || typeof quota.observed_at !== 'string') return null;
  const ms = Date.parse(quota.observed_at);
  return Number.isFinite(ms) ? ms : null;
};

interface SignalWindow {
  minutes: number;
  usedPercent: number;
  resetAtMs: number;
}

/** Mirrors the backend's quota history parser so both sides agree on windows. */
const readSignalWindows = (
  provider: ForecastProvider,
  signal: (name: string) => unknown,
  observedAtMs: number | null
): SignalWindow[] => {
  const windows: SignalWindow[] = [];
  const add = (minutes: number | null, used: number | null, resetAtMs: number | null) => {
    if (minutes === null || minutes <= 0 || used === null || used < 0 || resetAtMs === null) {
      return;
    }
    windows.push({ minutes, usedPercent: Math.min(100, used), resetAtMs });
  };

  if (provider === 'claude') {
    // Utilization is a 0..1 fraction; reset is unix seconds.
    (
      [
        ['7d', 7 * 24 * 60],
        ['5h', 5 * 60],
      ] as const
    ).forEach(([name, minutes]) => {
      const prefix = `Anthropic-Ratelimit-Unified-${name}-`;
      const fraction = parseNumber(signal(`${prefix}Utilization`));
      add(
        minutes,
        fraction === null ? null : fraction * 100,
        parseUnixMs(signal(`${prefix}Reset`))
      );
    });
    return windows;
  }

  if (provider === 'meta') {
    // Percent is 0..100; resets are unix seconds; the weekly window carries no duration.
    add(
      7 * 24 * 60,
      parseNumber(signal('Muse-Weekly-Used-Percent')),
      parseUnixMs(signal('Muse-Weekly-Reset-At'))
    );
    add(
      parseNumber(signal('Muse-Window-Minutes')),
      parseNumber(signal('Muse-Window-Used-Percent')),
      parseUnixMs(signal('Muse-Window-Reset-At'))
    );
    return windows;
  }

  (['Primary', 'Secondary'] as const).forEach((name) => {
    const prefix = `X-Codex-${name}-`;
    let resetAtMs = parseUnixMs(signal(`${prefix}Reset-At`));
    const after = parseNumber(signal(`${prefix}Reset-After-Seconds`));
    if (resetAtMs === null && after !== null && observedAtMs !== null) {
      resetAtMs = observedAtMs + after * 1000;
    }
    add(
      parseNumber(signal(`${prefix}Window-Minutes`)),
      parseNumber(signal(`${prefix}Used-Percent`)),
      resetAtMs
    );
  });
  return windows;
};

const providerOf = (file: AuthFileItem): string =>
  String(file.provider ?? file.type ?? '')
    .trim()
    .toLowerCase();

/** The credential's pooled window, or null when it reports none. */
export function readPoolCredential(file: AuthFileItem): PoolCredential | null {
  const provider = providerOf(file);
  const authId = typeof file.id === 'string' ? file.id : '';
  if (!isForecastProvider(provider) || !authId) return null;
  const signal = readSignals(file);
  if (!signal) return null;

  const observedAtMs = readObservedAtMs(file);
  const windows = readSignalWindows(provider, signal, observedAtMs);
  const chosen = windows.find((window) => window.minutes >= WEEKLY_MIN_MINUTES) ?? windows[0];
  if (!chosen) return null;

  return {
    authId,
    window: chosen.minutes >= WEEKLY_MIN_MINUTES ? 'weekly' : 'session',
    periodMs: chosen.minutes * 60 * 1000,
    usedPercent: chosen.usedPercent,
    resetAtMs: chosen.resetAtMs,
    observedAtMs,
    share: planShareOf(file),
  };
}

/**
 * A credential's latest history reading, for when it has no live signals (e.g.
 * after a gateway restart). Prefers the weekly window, like the live reader.
 */
const historyCredential = (
  file: AuthFileItem,
  samples: QuotaHistorySample[]
): PoolCredential | null => {
  const authId = typeof file.id === 'string' ? file.id : '';
  if (!authId) return null;
  const latestFirst = samples
    .filter((sample) => sample.authId === authId)
    .sort((left, right) => right.atMs - left.atMs);
  const chosen = latestFirst.find((sample) => sample.window === 'weekly') ?? latestFirst[0];
  if (!chosen) return null;
  return {
    authId,
    window: chosen.window,
    periodMs: chosen.windowMinutes * 60 * 1000,
    usedPercent: chosen.usedPercent,
    resetAtMs: chosen.resetAtMs,
    observedAtMs: chosen.atMs,
    share: planShareOf(file),
  };
};

/** Whether any enabled credential could join a pool, live or from history. */
export const hasForecastCredentials = (files: AuthFileItem[]): boolean =>
  files.some((file) => !file.disabled && isForecastProvider(providerOf(file)));

/**
 * One pool per provider that has at least one enabled credential reporting a
 * window, live or, failing that, in its latest history reading.
 */
export function buildPools(
  files: AuthFileItem[],
  samples: QuotaHistorySample[] = []
): ProviderPool[] {
  const byProvider = new Map<ForecastProvider, PoolCredential[]>();
  files.forEach((file) => {
    if (file.disabled) return;
    const provider = providerOf(file);
    if (!isForecastProvider(provider)) return;
    const credential = readPoolCredential(file) ?? historyCredential(file, samples);
    if (!credential) return;
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), credential]);
  });
  return FORECAST_PROVIDERS.flatMap((provider) => {
    const credentials = byProvider.get(provider);
    return credentials
      ? [
          {
            provider,
            credentials,
            capacity: credentials.reduce((sum, credential) => sum + credential.share.effective, 0),
          },
        ]
      : [];
  });
}

/** Used percent of a window now: zero once its reset has passed. */
const usedNow = (usedPercent: number, resetAtMs: number, nowMs: number) =>
  nowMs >= resetAtMs ? 0 : usedPercent;

/** The credential's shortest live window under a week (e.g. 5-hour), as of now. */
export function readShortWindow(
  file: AuthFileItem,
  nowMs: number
): { minutes: number; usedPercent: number } | null {
  const provider = providerOf(file);
  const signal = readSignals(file);
  if (!isForecastProvider(provider) || !signal) return null;
  const short = readSignalWindows(provider, signal, readObservedAtMs(file))
    .filter((window) => window.minutes < WEEKLY_MIN_MINUTES)
    .sort((left, right) => left.minutes - right.minutes)[0];
  return short
    ? { minutes: short.minutes, usedPercent: usedNow(short.usedPercent, short.resetAtMs, nowMs) }
    : null;
}

export interface PoolMultipliers {
  /**
   * Over every enabled credential of the provider; `remaining` is of the pooled
   * window, and nothing is left to show when `readEffective` is 0 (no readings).
   */
  totals: MultiplierTotals;
  /** Whether every pooled window is weekly. */
  weekly: boolean;
  /** The short window (e.g. 5-hour), when every pooled credential reports one of one length. */
  short: { minutes: number; remaining: number; of: number } | null;
}

export interface ProviderMultipliers {
  provider: ForecastProvider;
  multipliers: PoolMultipliers;
}

/**
 * Plan multipliers of each forecast provider with an enabled credential, read
 * or not: plans and our share over every enabled credential, what is left of
 * the pooled (weekly) window, and of the short one.
 */
export const providerMultipliers = (
  files: AuthFileItem[],
  pools: ProviderPool[],
  nowMs: number
): ProviderMultipliers[] =>
  FORECAST_PROVIDERS.flatMap((provider) => {
    const own = files.filter((file) => !file.disabled && providerOf(file) === provider);
    if (own.length === 0) return [];
    const pool = pools.find((candidate) => candidate.provider === provider);
    return [{ provider, multipliers: poolMultipliers(own, pool?.credentials ?? [], nowMs) }];
  });

function poolMultipliers(
  own: AuthFileItem[],
  credentials: PoolCredential[],
  nowMs: number
): PoolMultipliers {
  const pooled = new Map(credentials.map((credential) => [credential.authId, credential]));
  const totals = multiplierTotals(
    own.map((file) => {
      const credential = typeof file.id === 'string' ? pooled.get(file.id) : undefined;
      return {
        share: planShareOf(file),
        usedPercent: credential
          ? usedNow(credential.usedPercent, credential.resetAtMs, nowMs)
          : null,
      };
    })
  );
  const shorts = own.flatMap((file) =>
    typeof file.id === 'string' && pooled.has(file.id)
      ? [{ share: planShareOf(file), window: readShortWindow(file, nowMs) }]
      : []
  );
  const minutes = shorts[0]?.window?.minutes;
  const short =
    minutes !== undefined && shorts.every((entry) => entry.window?.minutes === minutes)
      ? {
          minutes,
          remaining: shorts.reduce(
            (sum, entry) => sum + remainingMultiplier(entry.share, entry.window?.usedPercent ?? 0),
            0
          ),
          of: shorts.reduce((sum, entry) => sum + entry.share.effective, 0),
        }
      : null;
  return {
    totals,
    weekly:
      credentials.length > 0 && credentials.every((credential) => credential.window === 'weekly'),
    short,
  };
}

/** A manual reset as a quota card or the gateway reports it. */
export interface ResetCreditLike {
  id: string;
  status?: string;
  expiresAt?: string;
}

/**
 * Reset credits the gateway caches for quota-aware routing (Codex manual resets and
 * Claude reset grants), listed with each credential as `quota_planning.reset_credits`.
 */
export function gatewayResetCredits(file: AuthFileItem): ResetCreditLike[] {
  const planning = file.quota_planning;
  if (!isRecord(planning) || !Array.isArray(planning.reset_credits)) return [];
  return planning.reset_credits.flatMap((credit) =>
    isRecord(credit) && typeof credit.expires_at === 'string'
      ? [
          {
            id: typeof credit.id === 'string' ? credit.id : '',
            status: 'available',
            expiresAt: credit.expires_at,
          },
        ]
      : []
  );
}

/**
 * Expiry instants of the pool's unused, unexpired manual resets, soonest first.
 * The gateway redeems one shortly before it expires only when that pays off, so the
 * projection never assumes one is used.
 */
export function poolResetCredits(
  pool: ProviderPool,
  files: AuthFileItem[],
  creditsOf: (file: AuthFileItem) => readonly ResetCreditLike[] | undefined,
  nowMs: number
): number[] {
  const ids = new Set(pool.credentials.map((credential) => credential.authId));
  // Auth files of one account report the same credits; count each id once.
  // Credits without an id cannot be matched, so each one is kept.
  const expiries = new Map(
    files
      .filter((file) => typeof file.id === 'string' && ids.has(file.id))
      .flatMap((file) => creditsOf(file) ?? [])
      .filter((credit) => credit.status === 'available')
      .map((credit, index) => [credit.id || index, Date.parse(credit.expiresAt ?? '')])
  );
  return [...expiries.values()]
    .filter((expiresAtMs) => expiresAtMs > nowMs)
    .sort((left, right) => left - right);
}

/** Manual reset expiries drawn on a chart spanning [fromMs, toMs]. */
export const creditsInView = (credits: number[], fromMs: number, toMs: number) =>
  credits.filter((expiresAtMs) => expiresAtMs >= fromMs && expiresAtMs <= toMs);

/** Drawn manual resets within toleranceMs of t, named in the tooltip there. */
export const creditsNear = (
  credits: number[],
  t: number,
  toleranceMs: number,
  fromMs: number,
  toMs: number
) =>
  creditsInView(credits, fromMs, toMs).filter(
    (expiresAtMs) => Math.abs(expiresAtMs - t) <= toleranceMs
  );

/* ---------- Current state and projection ---------- */

interface CredentialNow {
  share: PlanShare;
  usedPercent: number;
  /** Next reset strictly after now. */
  resetAtMs: number;
  periodMs: number;
  /** Percent per millisecond. */
  pace: number;
  nowMs: number;
}

/**
 * A reset that has already passed means the window is full again, with the next
 * reset one period on. `ratePerMs` is the measured daily-average drain; without
 * it the pace is the current window's average so far.
 */
export function credentialNow(
  credential: PoolCredential,
  nowMs: number,
  ratePerMs?: number
): CredentialNow {
  const { periodMs } = credential;
  let { resetAtMs, usedPercent } = credential;
  if (nowMs >= resetAtMs) {
    resetAtMs += (Math.floor((nowMs - resetAtMs) / periodMs) + 1) * periodMs;
    usedPercent = 0;
  }
  const elapsed = Math.max(MIN_PACE_ELAPSED_MS, nowMs - (resetAtMs - periodMs));
  const pace = ratePerMs ?? usedPercent / elapsed;
  return { share: credential.share, usedPercent, resetAtMs, periodMs, pace, nowMs };
}

type Side = 'left' | 'right';

/**
 * Projected remaining multiplier at t ≥ now. Usage between now and t is the
 * pace times the activity-weighted time between them. 'left' is the limit just
 * before t (before a reset lands).
 */
const projectedRemaining = (
  state: CredentialNow,
  clock: ActivityClock,
  t: number,
  side: Side
): number => {
  const { share, resetAtMs, periodMs, pace, usedPercent } = state;
  if (t < resetAtMs || (side === 'left' && t === resetAtMs)) {
    return remainingMultiplier(share, usedPercent + pace * clock.at(t));
  }
  let resets = Math.floor((t - resetAtMs) / periodMs);
  if (side === 'left' && (t - resetAtMs) % periodMs === 0) resets -= 1;
  const lastReset = resetAtMs + resets * periodMs;
  return remainingMultiplier(share, pace * (clock.at(t) - clock.at(lastReset)));
};

/** Every instant where the projection jumps (reset) or hits zero, i.e. the cap. */
const projectionBreakpoints = (
  state: CredentialNow,
  clock: ActivityClock,
  endMs: number
): number[] => {
  const { resetAtMs, periodMs, pace, usedPercent } = state;
  const { capPercent } = state.share;
  const points: number[] = [];
  if (pace > 0) {
    const emptyAt = clock.reach((capPercent - usedPercent) / pace);
    if (emptyAt < Math.min(resetAtMs, endMs)) points.push(emptyAt);
  }
  for (let reset = resetAtMs; reset <= endMs; reset += periodMs) {
    points.push(reset);
    if (pace > 0) {
      const emptyAt = clock.reach(clock.at(reset) + capPercent / pace);
      if (emptyAt < Math.min(reset + periodMs, endMs)) points.push(emptyAt);
    }
  }
  return points;
};

/**
 * Samples a pooled value at each breakpoint. A jump becomes two points at the
 * same instant (before, after) so straight segments between points are exact.
 */
const buildSeries = (
  times: number[],
  valueAt: (t: number, side: Side) => number | null
): SeriesPoint[] => {
  const series: SeriesPoint[] = [];
  Array.from(new Set(times))
    .sort((left, right) => left - right)
    .forEach((t) => {
      const before = valueAt(t, 'left');
      const after = valueAt(t, 'right');
      if (before !== null && after !== null && before !== after && series.length > 0) {
        series.push({ t, v: before });
      }
      if (after !== null) series.push({ t, v: after });
    });
  return series;
};

/** Which pace a projection uses: the expected one, or an edge of the likely range. */
export type PaceScenario = 'expected' | 'busy' | 'quiet';

const credentialStates = (
  pool: ProviderPool,
  nowMs: number,
  activity: PoolActivity,
  scenario: PaceScenario = 'expected'
) =>
  pool.credentials.map((credential) => {
    const state = credentialNow(credential, nowMs, activity.rates.get(credential.authId));
    if (scenario === 'expected') return state;
    // Without a measured range the window pace gets a fixed spread.
    const pace =
      activity.ranges.get(credential.authId)?.[scenario] ??
      state.pace * (scenario === 'busy' ? 1 + FALLBACK_SPREAD : 1 - FALLBACK_SPREAD);
    return { ...state, pace };
  });

/**
 * Pooled remaining multiplier from now to endMs. Between breakpoints (resets,
 * zero crossings, hours where the activity weight changes) it is exactly linear.
 * A busy scenario never lies above the expected one, a quiet one never below.
 */
export function projectPool(
  pool: ProviderPool,
  nowMs: number,
  endMs: number,
  activity: PoolActivity = FLAT_ACTIVITY,
  scenario: PaceScenario = 'expected'
): SeriesPoint[] {
  const states = credentialStates(pool, nowMs, activity, scenario);
  const clock = activityClock(activity.profile, nowMs, endMs);
  const times = [
    nowMs,
    endMs,
    ...clock.bends,
    ...states.flatMap((state) => projectionBreakpoints(state, clock, endMs)),
  ];
  return buildSeries(
    times.filter((t) => t >= nowMs && t <= endMs),
    (t, side) => states.reduce((sum, state) => sum + projectedRemaining(state, clock, t, side), 0)
  );
}

export interface PoolSummary {
  /** Multiplier left to us. */
  remaining: number;
  capacity: number;
  /** Pooled multiplier per hour, averaged over the day. */
  pacePerHour: number;
  /** The multiplier the next reset gives back. */
  nextReset: { atMs: number; restore: number } | null;
}

export function summarizePool(
  pool: ProviderPool,
  nowMs: number,
  activity: PoolActivity = FLAT_ACTIVITY
): PoolSummary {
  const states = credentialStates(pool, nowMs, activity);
  const remaining = states.reduce(
    (sum, state) => sum + remainingMultiplier(state.share, state.usedPercent),
    0
  );
  const pacePerHour = states.reduce(
    (sum, state) => sum + (state.pace * HOUR_MS * state.share.multiplier) / 100,
    0
  );

  const earliest = Math.min(...states.map((state) => state.resetAtMs));
  const resetting = states.filter((state) => state.resetAtMs - earliest <= SAME_RESET_TOLERANCE_MS);
  const clock = activityClock(
    activity.profile,
    nowMs,
    Math.max(nowMs, ...resetting.map((state) => state.resetAtMs))
  );
  const nextReset = Number.isFinite(earliest)
    ? {
        atMs: earliest,
        // What the reset restores is whatever the projection says is used of our share by then.
        restore: resetting.reduce(
          (sum, state) =>
            sum + state.share.effective - projectedRemaining(state, clock, state.resetAtMs, 'left'),
          0
        ),
      }
    : null;

  return { remaining, capacity: pool.capacity, pacePerHour, nextReset };
}

/* ---------- History ---------- */

interface Snapshot {
  atMs: number;
  usedPercent: number;
  resetAtMs: number;
}

/**
 * The credential's samples for its pooled window, oldest first. Window duration
 * must match too: a Codex credential can report two "session" windows.
 */
const samplesFor = (credential: PoolCredential, samples: QuotaHistorySample[]): Snapshot[] =>
  samples
    .filter(
      (sample) =>
        sample.authId === credential.authId &&
        sample.window === credential.window &&
        sample.windowMinutes * 60 * 1000 === credential.periodMs
    )
    .sort((left, right) => left.atMs - right.atMs);

/**
 * Used percent at t from snapshots that hold flat until the next one and drop to
 * zero at their reset. Null before the first snapshot: unknown, not zero.
 * Queries must not go backwards in (t, side) order, which buildSeries guarantees,
 * so the cursor only ever moves forward and the whole walk is a single pass.
 */
const snapshotCursor = (snapshots: Snapshot[]) => {
  let next = 0;
  return (t: number, side: Side): number | null => {
    while (
      next < snapshots.length &&
      (snapshots[next].atMs < t || (side === 'right' && snapshots[next].atMs === t))
    ) {
      next += 1;
    }
    const latest = next > 0 ? snapshots[next - 1] : null;
    if (!latest) return null;
    const reset = side === 'right' ? t >= latest.resetAtMs : t > latest.resetAtMs;
    return reset ? 0 : latest.usedPercent;
  };
};

/**
 * Each credential's snapshots, oldest first. The current snapshot seeds each
 * credential, so an idle credential with no samples in range still counts.
 */
const poolSnapshots = (
  pool: ProviderPool,
  samples: QuotaHistorySample[],
  nowMs: number
): Snapshot[][] =>
  pool.credentials.map((credential) => {
    const seed: Snapshot = {
      atMs: Math.min(credential.observedAtMs ?? nowMs, nowMs),
      usedPercent: credential.usedPercent,
      resetAtMs: credential.resetAtMs,
    };
    return [...samplesFor(credential, samples), seed].sort((left, right) => left.atMs - right.atMs);
  });

/** Pooled capacity at t: the effective multiplier of each credential known by then. */
const knownCapacityAt = (pool: ProviderPool, perCredential: Snapshot[][], t: number): number =>
  perCredential.reduce(
    (sum, snapshots, index) =>
      snapshots[0].atMs <= t ? sum + pool.credentials[index].share.effective : sum,
    0
  );

/**
 * Pooled remaining multiplier over [fromMs, nowMs]. A credential joins the sum at
 * its first snapshot, so adding a subscription shows as a step up instead of
 * hiding the pool's earlier history. The line starts once any value is known.
 */
export function poolHistory(
  pool: ProviderPool,
  samples: QuotaHistorySample[],
  fromMs: number,
  nowMs: number
): SeriesPoint[] {
  const perCredential = poolSnapshots(pool, samples, nowMs);

  const times = [
    fromMs,
    nowMs,
    ...perCredential.flatMap((snapshots) =>
      snapshots.flatMap((snapshot) => [snapshot.atMs, snapshot.resetAtMs])
    ),
  ].filter((t) => t >= fromMs && t <= nowMs);

  const cursors = perCredential.map(snapshotCursor);
  return buildSeries(times, (t, side) => {
    let sum: number | null = null;
    cursors.forEach((usedAt, index) => {
      const used = usedAt(t, side);
      if (used !== null) {
        sum = (sum ?? 0) + remainingMultiplier(pool.credentials[index].share, used);
      }
    });
    return sum;
  });
}

/**
 * Drain bucket edges ending on the next clock boundary: hours for up to three
 * days, otherwise local calendar days, which are 23 or 25 hours long across DST.
 */
export function drainEdges(nowMs: number, days: DrainSpanDays): number[] {
  if (days <= 3) {
    // Epoch arithmetic: local setters skip the repeated hour when clocks fall back.
    const endMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS + HOUR_MS;
    const hours = days * 24;
    return Array.from({ length: hours + 1 }, (_, index) => endMs - (hours - index) * HOUR_MS);
  }
  const end = new Date(nowMs);
  end.setHours(24, 0, 0, 0);
  return Array.from({ length: days + 1 }, (_, index) => {
    const edge = new Date(end);
    edge.setDate(end.getDate() - (days - index));
    return edge.getTime();
  });
}

/** Index of the bucket [edges[i], edges[i + 1]) holding t, or -1 outside them. */
const bucketIndex = (edges: number[], t: number): number => {
  if (edges.length < 2 || t < edges[0] || t >= edges[edges.length - 1]) return -1;
  let low = 0;
  let high = edges.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (edges[middle] <= t) low = middle;
    else high = middle;
  }
  return low;
};

/**
 * Above this share of its cap (or of 100% without one) a credential is
 * rationed: its drain shows what was left, not what was wanted, so pace ignores
 * that drain and that time. A credential blocked at a 40% cap is rationed from 34%.
 */
const CENSORED_ABOVE_USED = 85;

/** Used percent above which a credential is rationed. */
const rationedAbove = (credential: PoolCredential) =>
  (credential.share.capPercent * CENSORED_ABOVE_USED) / 100;

interface Drain {
  /** The earlier sample: the drain happened somewhere in (fromMs, atMs]. */
  fromMs: number;
  atMs: number;
  delta: number;
  /** Drawn from a window that was already rationed. */
  censored: boolean;
}

/**
 * Measured drain of one credential's snapshots: positive increments between
 * consecutive samples, timed at the later sample. A sample in a later window
 * counts from that window's known zero, which is never rationed.
 */
const drainOf = (snapshots: Snapshot[], rationedFrom: number): Drain[] => {
  const drains: Drain[] = [];
  for (let index = 1; index < snapshots.length; index += 1) {
    const previous = snapshots[index - 1];
    const current = snapshots[index];
    const newWindow = current.resetAtMs - previous.resetAtMs > SAME_RESET_TOLERANCE_MS;
    if (!newWindow && previous.resetAtMs - current.resetAtMs > SAME_RESET_TOLERANCE_MS) continue;
    const delta = current.usedPercent - (newWindow ? 0 : previous.usedPercent);
    const censored = !newWindow && previous.usedPercent > rationedFrom;
    if (delta > 0) drains.push({ fromMs: previous.atMs, atMs: current.atMs, delta, censored });
  }
  return drains;
};

/**
 * Gaps between consecutive samples of one reset window, where any drain would
 * have been seen. Unchanged readings count: their cost moved quota by less
 * than the rounding, and leaving it out would inflate percent per dollar.
 */
const observedOf = (snapshots: Snapshot[]): Span[] =>
  snapshots.slice(1).flatMap((current, index) => {
    const previous = snapshots[index];
    return previous.resetAtMs - current.resetAtMs > SAME_RESET_TOLERANCE_MS
      ? []
      : [{ startMs: previous.atMs, endMs: current.atMs }];
  });

/** Stretches up to nowMs spent rationed: from a rationed snapshot to the next one or its reset. */
const censoredSpans = (snapshots: Snapshot[], rationedFrom: number, nowMs: number) =>
  snapshots.flatMap((snapshot, index) => {
    if (snapshot.usedPercent <= rationedFrom) return [];
    const endMs = Math.min(snapshots[index + 1]?.atMs ?? nowMs, snapshot.resetAtMs, nowMs);
    return endMs > snapshot.atMs ? [{ startMs: snapshot.atMs, endMs }] : [];
  });

/**
 * Pooled multiplier consumed in each bucket: each credential's drained percent
 * scaled by its plan multiplier, cap or not. Each value is the total for its
 * bucket [edges[i], edges[i + 1]).
 */
export function drainBuckets(
  pool: ProviderPool,
  samples: QuotaHistorySample[],
  edges: number[]
): number[] {
  const buckets = new Array<number>(Math.max(0, edges.length - 1)).fill(0);
  pool.credentials.forEach((credential) => {
    drainOf(samplesFor(credential, samples), rationedAbove(credential)).forEach(
      ({ atMs, delta }) => {
        const bucket = bucketIndex(edges, atMs);
        if (bucket !== -1) buckets[bucket] += delta * credential.share.multiplier;
      }
    );
  });
  return buckets.map((value) => value / 100);
}

/* ---------- Activity: when in the day quota gets used ---------- */

/** Local hours [startHour, endHour) assumed asleep until history says otherwise. */
export interface SleepHours {
  startHour: number;
  endHour: number;
}

export const DEFAULT_SLEEP_HOURS: SleepHours = { startHour: 0, endHour: 8 };

/** Days of measured drain that weigh as much as the sleep baseline. */
const PROFILE_PRIOR_DAYS = 7;
/** Hours below this share of the daily mean count as asleep. */
const NIGHT_WEIGHT = 0.25;
/** Days of measured drain before the sleep stretch is learned rather than assumed. */
const MIN_SLEEP_DAYS = 3;
/** Quiet stretches shorter than this are not sleep; clipping to the baseline bounds long ones. */
const MIN_SLEEP_HOURS = 2;
/**
 * Pace weighs use and time by 2^(-age / HALF_LIFE_MS): recent days count more,
 * yet one busy or quiet day only nudges the pace.
 */
const HALF_LIFE_MS = 3 * DAY_MS;
/** Rates need at least this much history, and this much active time; less keeps the window pace. */
const MIN_RATE_COVERAGE_MS = 3 * HOUR_MS;
/** Whole past days whose rates set the likely range, and the span the pace decays over... */
const RANGE_DAYS = 14;
/** ...when at least this many are measurable; otherwise the range is a fixed spread. */
const MIN_RANGE_DAYS = 4;
const BUSY_PERCENTILE = 0.8;
const QUIET_PERCENTILE = 0.2;
/** Relative spread of the likely range without enough days to measure it. */
const FALLBACK_SPREAD = 0.4;

/** Busy and quiet paces, percent per millisecond: the edges of the likely range. */
export interface PaceRange {
  busy: number;
  quiet: number;
}

export interface PoolActivity {
  /** Weight of each local hour of the day, mean 1, zero while asleep: it only moves usage within the day. */
  profile: number[];
  /** The one sleep stretch of the day, learned from every provider's drain. */
  sleep: SleepHours;
  /** Distinct local days with measured drain. */
  learnedDays: number;
  /**
   * Measured drain per credential, percent per millisecond: drain over
   * activity-weighted time in the last RANGE_DAYS, both decayed with a
   * HALF_LIFE_MS half-life. Rationed drain and time are left out.
   */
  rates: ReadonlyMap<string, number>;
  /** Likely range per credential with a measured rate. */
  ranges: ReadonlyMap<string, PaceRange>;
}

/** Usage spread evenly over the day at each window's average pace. */
export const FLAT_ACTIVITY: PoolActivity = {
  profile: new Array<number>(24).fill(1),
  sleep: { startHour: 0, endHour: 0 },
  learnedDays: 0,
  rates: new Map(),
  ranges: new Map(),
};

const isSleepHour = (hour: number, { startHour, endHour }: SleepHours) =>
  startHour <= endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;

/** Zero while asleep, the waking hours sharing the day evenly. */
export function baselineProfile(sleep: SleepHours): number[] {
  const hours = Array.from({ length: 24 }, (_, hour) => hour);
  const awake = hours.filter((hour) => !isSleepHour(hour, sleep)).length;
  return hours.map((hour) => (isSleepHour(hour, sleep) ? 0 : 24 / awake));
}

/**
 * The one continuous sleep stretch in a day of hourly drain shares (mean 1):
 * quiet hours, with single active hours between them merged, at least
 * MIN_SLEEP_HOURS long and overlapping the baseline. The stretch overlapping
 * the baseline most wins, clipped to the baseline: one sleeps later or shorter,
 * not at noon. Without one there is no sleep, as when agents run all night.
 */
export function sleepStretch(shares: number[], baseline: SleepHours): SleepHours {
  const quiet = shares.map((share) => share < NIGHT_WEIGHT);
  const merged = quiet.map(
    (value, hour) => value || (quiet[(hour + 23) % 24] && quiet[(hour + 1) % 24])
  );
  const awakeHour = merged.indexOf(false);
  if (awakeHour === -1) return baseline;

  let best: { asleep: number[]; length: number } | null = null;
  let start = -1;
  // Walk one full day from an awake hour so no run wraps past the walk's end.
  for (let offset = 1; offset <= 24; offset += 1) {
    const hour = awakeHour + offset;
    if (merged[hour % 24]) {
      if (start === -1) start = hour;
      continue;
    }
    if (start === -1) continue;
    const length = hour - start;
    // The run's hours inside the baseline, in run order; a run around both of its
    // ends overlaps it twice, and the longer piece is the sleep.
    const pieces: number[][] = [];
    for (let index = 0; index < length; index += 1) {
      const h = (start + index) % 24;
      if (!isSleepHour(h, baseline)) continue;
      const last = pieces[pieces.length - 1];
      if (last && last[last.length - 1] === (h + 23) % 24) last.push(h);
      else pieces.push([h]);
    }
    const asleep = pieces.reduce<number[]>(
      (longest, piece) => (piece.length > longest.length ? piece : longest),
      []
    );
    if (
      length >= MIN_SLEEP_HOURS &&
      asleep.length > 0 &&
      (!best ||
        asleep.length > best.asleep.length ||
        (asleep.length === best.asleep.length && length > best.length))
    ) {
      best = { asleep, length };
    }
    start = -1;
  }
  return best
    ? { startHour: best.asleep[0], endHour: (best.asleep[best.asleep.length - 1] + 1) % 24 }
    : { startHour: 0, endHour: 0 };
}

/** Linearly interpolated quantile q (0..1) of a non-empty list. */
const percentile = (values: number[], q: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  return sorted[low] + (sorted[Math.ceil(position)] - sorted[low]) * (position - low);
};

/** One usage ledger row: API-equivalent cost of a provider's requests in one hour. */
export type LedgerCost = Pick<UsageLedgerBucket, 'hourMs' | 'provider' | 'authId' | 'costUsd'>;

/** Calibration needs this much drain, in base-plan percent, before ledger cost stands in for it. */
const MIN_CALIBRATION_DRAIN = 10;

interface Span {
  startMs: number;
  endMs: number;
}

/** How much an amount or a stretch of time at t counts toward a rate. */
type Weight = (t: number) => number;
const unweighted: Weight = () => 1;
/** One credential's part of a ledger row's cost, by the row's credential ('' before attribution). */
type CostPart = (authId: string) => number;

/** Length of [startMs, endMs] inside [fromMs, toMs]. */
const overlapMs = (startMs: number, endMs: number, fromMs: number, toMs: number) =>
  Math.max(0, Math.min(endMs, toMs) - Math.max(startMs, fromMs));

/** Length of [fromMs, toMs] outside every span, by the given measure. */
const outside = (
  fromMs: number,
  toMs: number,
  spans: Span[],
  measure: (startMs: number, endMs: number) => number
) =>
  spans.reduce(
    (sum, span) => {
      const startMs = Math.max(span.startMs, fromMs);
      const endMs = Math.min(span.endMs, toMs);
      return endMs > startMs ? sum - measure(startMs, endMs) : sum;
    },
    measure(fromMs, toMs)
  );

/**
 * Learns when in the (local) day quota is used, from every pool together (one
 * person sleeps once), and how fast each credential drains.
 *
 * The hour-of-day profile comes from the usage ledger's cost when there is any,
 * otherwise from quota drain, and blends into the sleep baseline as more days
 * are seen; each amount counts at the local hour it was recorded, so DST days
 * need no special case. The learned sleep stretch weighs zero; other hours keep
 * their learned weight, so a quiet afternoon is slower, not asleep.
 *
 * A pool whose quota drain can be matched to enough ledger cost takes its
 * decayed and daily rates from the ledger, converted at that ratio: each
 * credential its own cost, plus cost recorded before attribution split by its
 * decayed share of the drain.
 */
export function learnActivity(
  pools: ProviderPool[],
  samples: QuotaHistorySample[],
  nowMs: number,
  sleep: SleepHours,
  ledger: LedgerCost[] = []
): PoolActivity {
  const windowStartMs = nowMs - RANGE_DAYS * DAY_MS;
  const groups = pools.map((pool) => ({
    pool,
    entries: pool.credentials.map((credential) => {
      const snapshots = samplesFor(credential, samples).filter(
        (snapshot) => snapshot.atMs <= nowMs
      );
      return {
        authId: credential.authId,
        multiplier: credential.share.multiplier,
        oldestMs: snapshots.length > 0 ? snapshots[0].atMs : nowMs,
        drains: drainOf(snapshots, rationedAbove(credential)),
        observed: observedOf(snapshots),
        censored: censoredSpans(snapshots, rationedAbove(credential), nowMs),
      };
    }),
  }));

  // Ledger cost per forecast provider and hour, within the window.
  const ledgerRows = ledger.flatMap(({ hourMs, costUsd, authId, provider: name }) => {
    const provider = name.toLowerCase();
    return isForecastProvider(provider) && hourMs >= windowStartMs && hourMs < nowMs
      ? [{ hourMs, costUsd, authId, provider }]
      : [];
  });
  // Pace counts only cost served by pooled subscriptions, or recorded before
  // the ledger attributed credentials; API keys and removed accounts drain no quota.
  const pooled = new Set(pools.flatMap((pool) => pool.credentials.map((c) => c.authId)));
  const ledgerFromMs = ledgerRows.reduce((min, row) => Math.min(min, row.hourMs), Infinity);
  const costRows = new Map<ForecastProvider, typeof ledgerRows>();
  ledgerRows.forEach((row) => {
    if (row.authId && !pooled.has(row.authId)) return;
    const rows = costRows.get(row.provider) ?? [];
    rows.push(row);
    costRows.set(row.provider, rows);
  });
  /**
   * The provider's ledger cost in [fromMs, toMs], hours taken pro rata, each
   * weighted at its midpoint, and each row by the `part` its credential gets.
   */
  const costBetween = (
    provider: ForecastProvider,
    fromMs: number,
    toMs: number,
    weight: Weight,
    part: CostPart
  ) =>
    (costRows.get(provider) ?? []).reduce(
      (sum, { hourMs, costUsd, authId }) =>
        sum +
        (costUsd *
          part(authId) *
          overlapMs(hourMs, hourMs + HOUR_MS, fromMs, toMs) *
          weight(hourMs + HOUR_MS / 2)) /
          HOUR_MS,
      0
    );

  // Dense ledger cost beats sparse drain for when in the day quota gets used.
  // Rationed drain still says when, so it counts here.
  const ledgerUse = ledgerRows.map((row) => ({ atMs: row.hourMs, amount: row.costUsd }));
  const use = ledgerUse.some((point) => point.amount > 0)
    ? ledgerUse
    : groups.flatMap((group) =>
        group.entries.flatMap((entry) =>
          entry.drains.map((drain) => ({ atMs: drain.atMs, amount: drain.delta }))
        )
      );
  const byHour = new Array<number>(24).fill(0);
  const days = new Set<string>();
  use.forEach(({ atMs, amount }) => {
    if (amount <= 0) return;
    const date = new Date(atMs);
    byHour[date.getHours()] += amount;
    days.add(`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`);
  });
  const total = byHour.reduce((sum, value) => sum + value, 0);
  const learnedWeight = total > 0 ? days.size / (days.size + PROFILE_PRIOR_DAYS) : 0;
  const blended = baselineProfile(sleep).map(
    (prior, hour) =>
      (1 - learnedWeight) * prior + (total > 0 ? (learnedWeight * byHour[hour] * 24) / total : 0)
  );
  const stretch =
    total > 0 && days.size >= MIN_SLEEP_DAYS
      ? sleepStretch(
          byHour.map((value) => (value * 24) / total),
          sleep
        )
      : sleep;
  const awake = blended.map((value, hour) => (isSleepHour(hour, stretch) ? 0 : value));
  const mean = awake.reduce((sum, value) => sum + value, 0) / 24;
  const profile = awake.map((value) => value / mean);

  const decayed: Weight = (t) => 2 ** (-(nowMs - t) / HALF_LIFE_MS);
  /**
   * `used` (already weighted) over the time in (fromMs, toMs] outside the
   * rationed spans, weighted by the hour profile and by `weight` at each local
   * hour's midpoint. The profile keeps the night out, so the rate does not
   * swing with the time of day; a span that is mostly night has too little
   * active time to divide by.
   */
  const rateOver = (
    fromMs: number,
    toMs: number,
    censored: Span[],
    weight: Weight,
    used: (fromMs: number, toMs: number) => number
  ): number | null => {
    let real = 0;
    let active = 0;
    let weighted = 0;
    for (let startMs = fromMs; startMs < toMs;) {
      const endMs = Math.min(toMs, localHourStart(startMs) + HOUR_MS);
      const unrationed = outside(startMs, endMs, censored, (from, to) => to - from);
      const hourActive = unrationed * profile[new Date(startMs).getHours()];
      real += unrationed;
      active += hourActive;
      weighted += hourActive * weight((startMs + endMs) / 2);
      startMs = endMs;
    }
    if (real < MIN_RATE_COVERAGE_MS || active < MIN_RATE_COVERAGE_MS) return null;
    return used(fromMs, toMs) / weighted;
  };
  const pastDays = (fromMs: number) =>
    Array.from({ length: RANGE_DAYS }, (_, index) => nowMs - (index + 1) * DAY_MS).filter(
      (dayMs) => dayMs >= fromMs
    );

  const rates = new Map<string, number>();
  const ranges = new Map<string, PaceRange>();
  groups.forEach(({ pool, entries }) => {
    const ledgerPace = ledgerPaceOf(pool, entries);
    // Cost from before attribution is shared as the recent, decayed drain was, in base plans.
    const drained = entries.map(
      (entry) =>
        entry.multiplier *
        entry.drains.reduce((sum, drain) => sum + drain.delta * decayed(drain.atMs), 0)
    );
    const totalDrained = drained.reduce((sum, value) => sum + value, 0);

    entries.forEach((entry, index) => {
      /**
       * Unrationed drain per active millisecond in (fromMs, toMs], within the
       * credential's history; each drain is weighted at its (later) sample.
       */
      const historyRate = (fromMs: number, toMs: number, weight: Weight) =>
        rateOver(Math.max(fromMs, entry.oldestMs), toMs, entry.censored, weight, (from, to) =>
          entry.drains
            .filter((drain) => !drain.censored && drain.atMs > from && drain.atMs <= to)
            .reduce((sum, drain) => sum + drain.delta * weight(drain.atMs), 0)
        );
      const share = totalDrained > 0 ? drained[index] / totalDrained : 1 / entries.length;
      const fromLedger = ledgerPace?.(
        (authId) => (authId === entry.authId ? 1 : authId ? 0 : share),
        entry.multiplier
      );

      let expected: number;
      let daily: number[];
      if (fromLedger) {
        expected = fromLedger.pace;
        daily = fromLedger.daily;
      } else {
        const pace = historyRate(windowStartMs, nowMs, decayed);
        if (pace === null) return;
        expected = pace;
        daily = pastDays(entry.oldestMs).flatMap(
          (fromMs) => historyRate(fromMs, fromMs + DAY_MS, unweighted) ?? []
        );
      }
      rates.set(entry.authId, expected);
      const measured = daily.length >= MIN_RANGE_DAYS;
      ranges.set(entry.authId, {
        busy: Math.max(
          expected,
          measured ? percentile(daily, BUSY_PERCENTILE) : expected * (1 + FALLBACK_SPREAD)
        ),
        quiet: Math.min(
          expected,
          measured ? percentile(daily, QUIET_PERCENTILE) : expected * (1 - FALLBACK_SPREAD)
        ),
      });
    });
  });

  /**
   * Decayed and daily rates from the part of the pool's ledger cost a
   * credential gets, in its own percent per active millisecond; null when the
   * pool's drain cannot be matched to enough cost.
   * Quota per dollar is measured in base-plan percent (a 10× plan's 1% is 10),
   * since a dollar drains a bigger plan less, over the intervals the pool's drain
   * was recorded in, leaving out time the pool as a whole was rationed. All
   * drain counts there, since a rationed credential's drain is still quota
   * spent; the same rationed time is then left out of the rates. Rates start
   * at the pool's first sample: earlier cost (e.g. imports) may not have been
   * the pool's, though it still shapes the hour-of-day profile.
   */
  function ledgerPaceOf(
    pool: ProviderPool,
    entries: { multiplier: number; oldestMs: number; drains: Drain[]; observed: Span[] }[]
  ): ((part: CostPart, multiplier: number) => { pace: number; daily: number[] } | null) | null {
    if (!Number.isFinite(ledgerFromMs)) return null;
    const drains = entries.flatMap((entry) =>
      entry.drains.map((drain) => ({ ...drain, delta: drain.delta * entry.multiplier }))
    );
    if (drains.length === 0) return null;
    // Merged, the observed gaps are when cost would have shown up as drain.
    const intervals: Span[] = [];
    entries
      .flatMap((entry) => entry.observed)
      .map(({ startMs, endMs }) => ({ startMs: Math.max(startMs, ledgerFromMs), endMs }))
      .filter((span) => span.endMs > span.startMs)
      .sort((left, right) => left.startMs - right.startMs)
      .forEach((span) => {
        const last = intervals[intervals.length - 1];
        if (last && span.startMs <= last.endMs) last.endMs = Math.max(last.endMs, span.endMs);
        else intervals.push({ ...span });
      });
    if (intervals.length === 0) return null;

    // Rationed relative to the credentials the pool had at the time.
    const snapshots = poolSnapshots(pool, samples, nowMs);
    const history = poolHistory(pool, samples, intervals[0].startMs, nowMs);
    const censored = history.flatMap((point, index) => {
      const endMs = history[index + 1]?.t ?? nowMs;
      const rationedBelow =
        (knownCapacityAt(pool, snapshots, point.t) * (100 - CENSORED_ABOVE_USED)) / 100;
      return point.v < rationedBelow && endMs > point.t ? [{ startMs: point.t, endMs }] : [];
    });
    const cost = (fromMs: number, toMs: number, weight: Weight, part: CostPart) =>
      outside(fromMs, toMs, censored, (from, to) =>
        costBetween(pool.provider, from, to, weight, part)
      );

    // A drain partly before the ledger or partly rationed counts pro rata.
    const drain = drains.reduce((sum, { fromMs, atMs, delta }) => {
      const inside = outside(
        Math.max(fromMs, ledgerFromMs),
        atMs,
        censored,
        (from, to) => to - from
      );
      return atMs > fromMs ? sum + (delta * Math.max(0, inside)) / (atMs - fromMs) : sum;
    }, 0);
    const spent = intervals.reduce(
      (sum, span) => sum + cost(span.startMs, span.endMs, unweighted, () => 1),
      0
    );
    if (drain < MIN_CALIBRATION_DRAIN || spent <= 0) return null;
    const basePercentPerDollar = drain / spent;
    const paceFromMs = Math.max(ledgerFromMs, Math.min(...entries.map((entry) => entry.oldestMs)));

    return (part, multiplier) => {
      const ledgerRate = (fromMs: number, toMs: number, weight: Weight) =>
        rateOver(
          Math.max(fromMs, paceFromMs),
          toMs,
          censored,
          weight,
          (from, to) => (basePercentPerDollar * cost(from, to, weight, part)) / multiplier
        );
      const pace = ledgerRate(windowStartMs, nowMs, decayed);
      if (pace === null) return null;
      return {
        pace,
        daily: pastDays(paceFromMs).flatMap(
          (fromMs) => ledgerRate(fromMs, fromMs + DAY_MS, unweighted) ?? []
        ),
      };
    };
  }

  return { profile, sleep: stretch, learnedDays: days.size, rates, ranges };
}

/** Hours of the day inside the sleep stretch. */
export const nightHours = (sleep: SleepHours): boolean[] =>
  Array.from({ length: 24 }, (_, hour) => isSleepHour(hour, sleep));

/** Start of the local clock hour holding t (zones with whole-hour DST shifts). */
const localHourStart = (t: number): number => {
  const date = new Date(t);
  return t - (date.getMinutes() * 60 + date.getSeconds()) * 1000 - date.getMilliseconds();
};

/** Splits [fromMs, toMs) into local clock hours, merging neighbours that share a key. */
function localHourRuns<K>(
  fromMs: number,
  toMs: number,
  keyOf: (hour: number) => K
): { startMs: number; endMs: number; key: K }[] {
  const runs: { startMs: number; endMs: number; key: K }[] = [];
  let cursor = fromMs;
  do {
    const endMs = Math.min(toMs, localHourStart(cursor) + HOUR_MS);
    const key = keyOf(new Date(cursor).getHours());
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.endMs = endMs;
    else runs.push({ startMs: cursor, endMs, key });
    cursor = endMs;
  } while (cursor < toMs);
  return runs;
}

/** Night stretches within [fromMs, toMs]. */
export const nightBands = (
  night: boolean[],
  fromMs: number,
  toMs: number
): { startMs: number; endMs: number }[] =>
  toMs > fromMs
    ? localHourRuns(fromMs, toMs, (hour) => night[hour])
        .filter((run) => run.key)
        .map(({ startMs, endMs }) => ({ startMs, endMs }))
    : [];

interface ActivityClock {
  /** Activity-weighted milliseconds from the clock's start to t. */
  at: (t: number) => number;
  /** Earliest instant where at() reaches target; Infinity beyond the clock's end. */
  reach: (target: number) => number;
  /** Instants where the weight changes. */
  bends: number[];
}

/** Piecewise-constant activity over [fromMs, toMs], one weight per local hour. */
function activityClock(profile: number[], fromMs: number, toMs: number): ActivityClock {
  const runs = localHourRuns(fromMs, toMs, (hour) => profile[hour]);
  const cumulative: number[] = [0];
  runs.forEach((run) => {
    cumulative.push(cumulative[cumulative.length - 1] + (run.endMs - run.startMs) * run.key);
  });
  /** Index of the last run starting at or before t. */
  const runAt = (t: number) => {
    let low = 0;
    let high = runs.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (runs[middle].startMs <= t) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  return {
    at: (t) => {
      const index = runAt(t);
      return cumulative[index] + (t - runs[index].startMs) * runs[index].key;
    },
    reach: (target) => {
      if (target <= 0) return fromMs;
      // First run whose end reaches the target; its weight is positive.
      let low = 0;
      let high = runs.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (cumulative[middle + 1] >= target) high = middle;
        else low = middle + 1;
      }
      if (low === runs.length) return Infinity;
      return runs[low].startMs + (target - cumulative[low]) / runs[low].key;
    },
    bends: runs.slice(1).map((run) => run.startMs),
  };
}

/**
 * When a projection first drops into zero, or null if it never does. A pool
 * that starts empty only runs out again after a reset refills it.
 */
export const runsOutAt = (series: SeriesPoint[]): number | null =>
  series.find((point, index) => index > 0 && point.v <= 1e-9 && series[index - 1].v > 1e-9)?.t ??
  null;

/** Linear interpolation; at a jump the later value wins. Null outside the series. */
export function valueAt(series: SeriesPoint[], t: number): number | null {
  if (series.length === 0 || t < series[0].t || t > series[series.length - 1].t) return null;
  for (let index = series.length - 1; index >= 0; index -= 1) {
    const point = series[index];
    if (point.t > t) continue;
    const next = series[index + 1];
    if (!next || next.t === point.t) return point.v;
    return point.v + ((next.v - point.v) * (t - point.t)) / (next.t - point.t);
  }
  return null;
}
