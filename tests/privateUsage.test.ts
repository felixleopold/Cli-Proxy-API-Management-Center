import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  normalizePrivateHistoryCredentials,
  normalizeQuotaHistorySamples,
} from '../src/services/api/quotaHistory';
import { privateAccountViews } from '../src/features/quota/privateUsageModel';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-11-08T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

const payload = {
  samples: [
    // 5-hour window resetting at 05:00: 40% used at 01:00, 90% at 04:00.
    {
      at: iso(T0 + HOUR),
      auth_id: 'mine',
      provider: 'claude',
      window: 'session',
      window_minutes: 300,
      used_percent: 40,
      reset_at: iso(T0 + 5 * HOUR),
    },
    {
      at: iso(T0 + 4 * HOUR),
      auth_id: 'mine',
      provider: 'claude',
      window: 'session',
      window_minutes: 300,
      used_percent: 90,
      reset_at: iso(T0 + 5 * HOUR),
    },
  ],
  credentials: [
    { auth_id: 'mine', label: 'Max', provider: 'Claude', private_user: 'Felix', disabled: false },
    { auth_id: 'quiet', label: '', provider: 'claude', private_user: 'Felix', disabled: true },
  ],
};

describe('private usage', () => {
  const credentials = normalizePrivateHistoryCredentials(payload);
  const samples = normalizeQuotaHistorySamples(payload);
  const nowMs = T0 + 6 * HOUR;
  const views = privateAccountViews(credentials, samples, T0, nowMs, nowMs + 24 * HOUR);

  test('lists every private credential, also one without samples', () => {
    expect(credentials.map((c) => [c.authId, c.label, c.provider, c.disabled])).toEqual([
      ['mine', 'Max', 'claude', false],
      ['quiet', 'quiet', 'claude', true],
    ]);
    expect(views[1].windows.map((w) => w.lastSampleMs)).toEqual([null, null]);
  });

  test('holds each reading, refills at the passed reset and rolls the next reset forward', () => {
    const session = views[0].windows[0];
    expect(session.history).toEqual([
      { t: T0 + HOUR, v: 60 },
      { t: T0 + 4 * HOUR, v: 60 },
      { t: T0 + 4 * HOUR, v: 10 },
      { t: T0 + 5 * HOUR, v: 10 },
      { t: T0 + 5 * HOUR, v: 100 },
      { t: nowMs, v: 100 },
    ]);
    expect(session.remaining).toBe(100);
    expect(session.nextResetMs).toBe(T0 + 10 * HOUR);
    expect(session.resets.map((r) => [r.atMs, r.restore, r.projected])).toEqual([
      [T0 + 5 * HOUR, 90, false],
    ]);
  });

  test('the page is routed but linked from nowhere', () => {
    const files = readdirSync('src', { recursive: true, encoding: 'utf8' }).filter((file) =>
      /\.(ts|tsx|json)$/.test(file)
    );
    const linking = files.filter((file) =>
      /['"]#?\/private-usage['"]/.test(readFileSync(join('src', file), 'utf8'))
    );
    expect(linking).toEqual([join('router', 'MainRoutes.tsx')]);
  });
});
