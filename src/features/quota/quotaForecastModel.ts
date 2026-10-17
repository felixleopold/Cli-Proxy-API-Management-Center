/**
 * Pooled quota forecast.
 *
 * Each credential contributes 100% of one window to its provider's pool: the
 * weekly window, or its first window when it has no weekly one. Current state
 * comes from the passive quota signals on GET /credentials; history comes from
 * the backend's quota history samples. Everything here is pure so it can be
 * tested without a browser; QuotaForecast.tsx is layout only.
 */

import type { AuthFileItem } from '@/types';
import type { QuotaHistorySample, QuotaHistoryWindow } from '@/services/api/quotaHistory';
import { isRecord } from '@/utils/helpers';

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export const FORECAST_PROVIDERS = ['claude', 'codex'] as const;
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
}

export interface ProviderPool {
  provider: ForecastProvider;
  credentials: PoolCredential[];
  /** 100% per credential. */
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
  };
}

/** One pool per provider that has at least one enabled credential reporting a window. */
export function buildPools(files: AuthFileItem[]): ProviderPool[] {
  const byProvider = new Map<ForecastProvider, PoolCredential[]>();
  files.forEach((file) => {
    if (file.disabled) return;
    const provider = providerOf(file);
    const credential = readPoolCredential(file);
    if (!credential || !isForecastProvider(provider)) return;
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), credential]);
  });
  return FORECAST_PROVIDERS.flatMap((provider) => {
    const credentials = byProvider.get(provider);
    return credentials ? [{ provider, credentials, capacity: credentials.length * 100 }] : [];
  });
}

/* ---------- Current state and projection ---------- */

interface CredentialNow {
  usedPercent: number;
  /** Next reset strictly after now. */
  resetAtMs: number;
  periodMs: number;
  /** Percent per millisecond. */
  pace: number;
  nowMs: number;
}

/** A reset that has already passed means the window is full again, with the next reset one period on. */
export function credentialNow(credential: PoolCredential, nowMs: number): CredentialNow {
  const { periodMs } = credential;
  let { resetAtMs, usedPercent } = credential;
  if (nowMs >= resetAtMs) {
    resetAtMs += (Math.floor((nowMs - resetAtMs) / periodMs) + 1) * periodMs;
    usedPercent = 0;
  }
  const elapsed = Math.max(MIN_PACE_ELAPSED_MS, nowMs - (resetAtMs - periodMs));
  return { usedPercent, resetAtMs, periodMs, pace: usedPercent / elapsed, nowMs };
}

type Side = 'left' | 'right';

/** Projected remaining percent at t ≥ now. 'left' is the limit just before t (before a reset lands). */
const projectedRemaining = (state: CredentialNow, t: number, side: Side): number => {
  const { resetAtMs, periodMs, pace, usedPercent, nowMs } = state;
  if (t < resetAtMs || (side === 'left' && t === resetAtMs)) {
    return Math.max(0, 100 - usedPercent - pace * (t - nowMs));
  }
  let since = (t - resetAtMs) % periodMs;
  if (side === 'left' && since === 0) since = periodMs;
  return Math.max(0, 100 - pace * since);
};

/** Every instant where the projection jumps (reset) or bends (hits zero). */
const projectionBreakpoints = (state: CredentialNow, endMs: number): number[] => {
  const { resetAtMs, periodMs, pace, usedPercent, nowMs } = state;
  const points: number[] = [];
  if (pace > 0) {
    const emptyAt = nowMs + (100 - usedPercent) / pace;
    if (emptyAt < Math.min(resetAtMs, endMs)) points.push(emptyAt);
  }
  for (let reset = resetAtMs; reset <= endMs; reset += periodMs) {
    points.push(reset);
    if (pace > 0) {
      const emptyAt = reset + 100 / pace;
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

/** Pooled remaining percent from now to endMs. */
export function projectPool(pool: ProviderPool, nowMs: number, endMs: number): SeriesPoint[] {
  const states = pool.credentials.map((credential) => credentialNow(credential, nowMs));
  const times = [nowMs, endMs, ...states.flatMap((state) => projectionBreakpoints(state, endMs))];
  return buildSeries(
    times.filter((t) => t >= nowMs && t <= endMs),
    (t, side) => states.reduce((sum, state) => sum + projectedRemaining(state, t, side), 0)
  );
}

export interface PoolSummary {
  remaining: number;
  capacity: number;
  /** Pooled percent per hour. */
  pacePerHour: number;
  nextReset: { atMs: number; restorePercent: number } | null;
}

export function summarizePool(pool: ProviderPool, nowMs: number): PoolSummary {
  const states = pool.credentials.map((credential) => credentialNow(credential, nowMs));
  const remaining = states.reduce((sum, state) => sum + 100 - state.usedPercent, 0);
  const pacePerHour = states.reduce((sum, state) => sum + state.pace * HOUR_MS, 0);

  const earliest = Math.min(...states.map((state) => state.resetAtMs));
  const resetting = states.filter((state) => state.resetAtMs - earliest <= SAME_RESET_TOLERANCE_MS);
  const nextReset = Number.isFinite(earliest)
    ? {
        atMs: earliest,
        // What the reset restores is whatever the projection says is used by then.
        restorePercent: resetting.reduce(
          (sum, state) => sum + 100 - projectedRemaining(state, state.resetAtMs, 'left'),
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
 * Pooled remaining percent over [fromMs, nowMs]. The current snapshot seeds each
 * credential, so an idle credential with no samples in range still counts. The
 * line starts once every credential's value is known.
 */
export function poolHistory(
  pool: ProviderPool,
  samples: QuotaHistorySample[],
  fromMs: number,
  nowMs: number
): SeriesPoint[] {
  const perCredential = pool.credentials.map((credential) => {
    const seed: Snapshot = {
      atMs: Math.min(credential.observedAtMs ?? nowMs, nowMs),
      usedPercent: credential.usedPercent,
      resetAtMs: credential.resetAtMs,
    };
    return [...samplesFor(credential, samples), seed].sort((left, right) => left.atMs - right.atMs);
  });

  const times = [
    fromMs,
    nowMs,
    ...perCredential.flatMap((snapshots) =>
      snapshots.flatMap((snapshot) => [snapshot.atMs, snapshot.resetAtMs])
    ),
  ].filter((t) => t >= fromMs && t <= nowMs);

  const cursors = perCredential.map(snapshotCursor);
  return buildSeries(times, (t, side) => {
    let sum = 0;
    for (const usedAt of cursors) {
      const used = usedAt(t, side);
      if (used === null) return null;
      sum += 100 - used;
    }
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
 * Pooled used percent consumed in each bucket: positive increments between
 * consecutive samples of the same credential window (same reset). Each value is
 * the total for its bucket [edges[i], edges[i + 1]).
 */
export function drainBuckets(
  pool: ProviderPool,
  samples: QuotaHistorySample[],
  edges: number[]
): number[] {
  const buckets = new Array<number>(Math.max(0, edges.length - 1)).fill(0);
  pool.credentials.forEach((credential) => {
    const snapshots = samplesFor(credential, samples);
    for (let index = 1; index < snapshots.length; index += 1) {
      const previous = snapshots[index - 1];
      const current = snapshots[index];
      if (Math.abs(current.resetAtMs - previous.resetAtMs) > SAME_RESET_TOLERANCE_MS) continue;
      const delta = current.usedPercent - previous.usedPercent;
      const bucket = delta > 0 ? bucketIndex(edges, current.atMs) : -1;
      if (bucket !== -1) buckets[bucket] += delta;
    }
  });
  return buckets;
}

/** Scales a pooled series to percent of the pool, so pools of different sizes share one axis. */
export const toPoolShare = (series: SeriesPoint[], capacity: number): SeriesPoint[] =>
  capacity > 0 ? series.map((point) => ({ t: point.t, v: (point.v / capacity) * 100 })) : [];

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
