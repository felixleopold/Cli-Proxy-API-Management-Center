/**
 * Private usage (hidden `/private-usage` page): each private credential's 5-hour
 * session and weekly windows as remaining percent over time, from the samples of
 * `/observability/quota/history/private`. Samples are recorded on change, so the
 * series holds each reading until the next one, refills to 100% at every reset
 * the readings passed, and ahead of now stays flat until the next reset.
 * Shaped as the forecast chart's row (capacity 100), so `RemainingChart` draws it.
 */

import type {
  PrivateHistoryCredential,
  QuotaHistorySample,
  QuotaHistoryWindow,
} from '@/services/api/quotaHistory';
import { valueAt, type PoolResetEvent, type SeriesPoint } from './quotaForecastModel';

export const PRIVATE_WINDOWS: readonly QuotaHistoryWindow[] = ['session', 'weekly'];

export interface PrivateWindowView {
  window: QuotaHistoryWindow;
  /** Remaining percent now; null without samples. */
  remaining: number | null;
  nextResetMs: number | null;
  lastSampleMs: number | null;
  history: SeriesPoint[];
  /** Flat at the current value until the next reset, then full. */
  projection: SeriesPoint[];
  resets: PoolResetEvent[];
}

export interface PrivateAccountView {
  credential: PrivateHistoryCredential;
  windows: PrivateWindowView[];
}

/** The first reset after `afterMs`, rolling a stale reset forward by whole periods. */
export const nextResetAfter = (resetMs: number, afterMs: number, periodMs: number): number =>
  resetMs > afterMs
    ? resetMs
    : resetMs + (Math.floor((afterMs - resetMs) / periodMs) + 1) * periodMs;

const resetEvent = (
  authId: string,
  atMs: number,
  usedPercent: number,
  projected: boolean
): PoolResetEvent => ({
  atMs,
  projected,
  restore: usedPercent,
  utilization: usedPercent / 100,
  accounts: [{ authId, usedPercent, capPercent: 100 }],
});

/** The series from `fromMs` on, starting with its value there. */
const clipFrom = (series: SeriesPoint[], fromMs: number): SeriesPoint[] => {
  const start = valueAt(series, fromMs);
  const after = series.filter((point) => point.t > fromMs);
  return start === null ? after : [{ t: fromMs, v: start }, ...after];
};

/** One window of one credential; `samples` are that window's, sorted by time. */
export function privateWindowView(
  authId: string,
  window: QuotaHistoryWindow,
  allSamples: readonly QuotaHistorySample[],
  fromMs: number,
  nowMs: number,
  toMs: number
): PrivateWindowView {
  // A sample newer than the minute clock would make the history double back.
  const samples = allSamples.filter((sample) => sample.atMs <= nowMs);
  const last = samples[samples.length - 1];
  if (!last) {
    return {
      window,
      remaining: null,
      nextResetMs: null,
      lastSampleMs: null,
      history: [],
      projection: [],
      resets: [],
    };
  }

  const history: SeriesPoint[] = [];
  const resets: PoolResetEvent[] = [];
  // A sample taken after its window reset reports usage that has already expired.
  const usedOf = (sample: QuotaHistorySample) => (sample.resetAtMs <= sample.atMs ? 0 : sample.usedPercent);
  // Holds `used` until `untilMs`, refilling at the first reset in between.
  const hold = (sample: QuotaHistorySample, untilMs: number) => {
    const periodMs = sample.windowMinutes * 60_000;
    const resetMs = nextResetAfter(sample.resetAtMs, sample.atMs, periodMs);
    const used = usedOf(sample);
    const remaining = 100 - used;
    if (resetMs > untilMs) {
      history.push({ t: untilMs, v: remaining });
      return remaining;
    }
    history.push({ t: resetMs, v: remaining }, { t: resetMs, v: 100 });
    if (used > 0) resets.push(resetEvent(authId, resetMs, used, false));
    if (untilMs > resetMs) history.push({ t: untilMs, v: 100 });
    return 100;
  };

  samples.forEach((sample, index) => {
    if (index > 0) hold(samples[index - 1], sample.atMs);
    history.push({ t: sample.atMs, v: 100 - usedOf(sample) });
  });
  const remaining = hold(last, nowMs);

  const periodMs = last.windowMinutes * 60_000;
  const nextResetMs = nextResetAfter(last.resetAtMs, nowMs, periodMs);
  const projection: SeriesPoint[] = [{ t: nowMs, v: remaining }];
  if (nextResetMs < toMs) {
    projection.push(
      { t: nextResetMs, v: remaining },
      { t: nextResetMs, v: 100 },
      { t: toMs, v: 100 }
    );
    if (remaining < 100) resets.push(resetEvent(authId, nextResetMs, 100 - remaining, true));
  } else {
    projection.push({ t: toMs, v: remaining });
  }

  return {
    window,
    remaining,
    nextResetMs,
    lastSampleMs: last.atMs,
    history: clipFrom(history, fromMs),
    projection,
    resets: resets.filter((event) => event.atMs >= fromMs),
  };
}

/**
 * One view per listed credential (accounts without samples included), then any
 * credential that only appears in the samples, each with its session and weekly window.
 */
export function privateAccountViews(
  credentials: readonly PrivateHistoryCredential[],
  samples: readonly QuotaHistorySample[],
  fromMs: number,
  nowMs: number,
  toMs: number
): PrivateAccountView[] {
  const listed = new Set(credentials.map((credential) => credential.authId));
  const unlisted = new Map<string, PrivateHistoryCredential>();
  samples.forEach((sample) => {
    if (listed.has(sample.authId) || unlisted.has(sample.authId)) return;
    unlisted.set(sample.authId, {
      authId: sample.authId,
      label: sample.authId,
      provider: sample.provider,
      privateUser: '',
      disabled: false,
    });
  });
  return [...credentials, ...unlisted.values()].map((credential) => ({
    credential,
    windows: PRIVATE_WINDOWS.map((window) =>
      privateWindowView(
        credential.authId,
        window,
        samples.filter((sample) => sample.authId === credential.authId && sample.window === window),
        fromMs,
        nowMs,
        toMs
      )
    ),
  }));
}
