import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  WEEK_MS,
  assignUserSlots,
  buildClientRows,
  buildWeekWindows,
  clientKeyFingerprint,
  costBetween,
  earliestUpcomingReset,
  resolveWeekAnchor,
  rollupWindows,
} from '../src/features/usage/usageModel';
import { normalizeUsageLedger } from '../src/services/api/usageLedger';
import type { UsageLedgerBucket } from '../src/types';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-16T12:00:00Z');

const bucket = (overrides: Partial<UsageLedgerBucket>): UsageLedgerBucket => ({
  hourMs: NOW - HOUR,
  fingerprint: 'aaaaaaaaaaaa',
  provider: 'claude',
  model: 'claude-opus-5-5',
  requests: 1,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: 1,
  priced: true,
  ...overrides,
});

describe('week anchoring', () => {
  test('uses the earliest upcoming Claude reset and rolls stale ones forward', () => {
    const soon = NOW + 2 * HOUR;
    const later = NOW + 30 * HOUR;
    expect(earliestUpcomingReset([later, soon], NOW)).toBe(soon);
    // A reset cached last week still names the same weekly boundary.
    expect(earliestUpcomingReset([soon - WEEK_MS], NOW)).toBe(soon);
    expect(earliestUpcomingReset([NOW], NOW)).toBe(NOW + WEEK_MS);
  });

  test('windows end at the reset and step back by whole weeks', () => {
    const resetMs = NOW + 5 * HOUR;
    const anchor = resolveWeekAnchor('claude', [resetMs], NOW);
    expect(anchor).toEqual({ kind: 'claude', resetMs });

    const windows = buildWeekWindows(anchor, NOW, 3);
    expect(windows.map((window) => [window.startMs, window.endMs, window.current])).toEqual([
      [resetMs - 3 * WEEK_MS, resetMs - 2 * WEEK_MS, false],
      [resetMs - 2 * WEEK_MS, resetMs - WEEK_MS, false],
      [resetMs - WEEK_MS, resetMs, true],
    ]);
  });

  test('falls back to calendar weeks starting Monday 00:00 local', () => {
    const anchor = resolveWeekAnchor('claude', [], NOW);
    expect(anchor).toEqual({ kind: 'calendar' });

    const [previous, current] = buildWeekWindows(anchor, NOW, 2);
    const start = new Date(current.startMs);
    expect([start.getDay(), start.getHours(), start.getMinutes()]).toEqual([1, 0, 0]);
    expect(current.startMs).toBeLessThanOrEqual(NOW);
    expect(current.endMs).toBeGreaterThan(NOW);
    expect(previous.endMs).toBe(current.startMs);
  });
});

describe('rollups', () => {
  const windows = buildWeekWindows({ kind: 'claude', resetMs: NOW + HOUR }, NOW, 2);
  const clients = [
    { fingerprint: 'aaaaaaaaaaaa', device: 'MacBook', user: 'Felix', configured: true },
    { fingerprint: 'bbbbbbbbbbbb', device: 'iPhone', user: 'Felix', configured: true },
    { fingerprint: 'cccccccccccc', device: '', user: '', configured: true },
  ];

  test('groups by window, user, device and model; unlabelled keys are unassigned', () => {
    const buckets = [
      bucket({ costUsd: 2 }),
      bucket({ costUsd: 3, model: 'claude-sonnet-5-5' }),
      bucket({ fingerprint: 'bbbbbbbbbbbb', costUsd: 1 }),
      bucket({ fingerprint: 'cccccccccccc', costUsd: 4 }),
      bucket({ fingerprint: 'dddddddddddd', costUsd: 0.5 }),
      // Previous window, and one before the range entirely.
      bucket({ hourMs: NOW - 8 * 24 * HOUR, costUsd: 7 }),
      bucket({ hourMs: NOW - 30 * 24 * HOUR, costUsd: 100 }),
    ];
    const [previous, current] = rollupWindows(buckets, clients, windows);

    expect(previous.costUsd).toBe(7);
    expect(current.costUsd).toBe(10.5);
    expect(current.tokens).toBe(5 * 150);

    const [felix, unassigned] = current.users;
    expect(felix.user).toBe('Felix');
    expect(felix.costUsd).toBe(6);
    expect(felix.devices.map((device) => [device.device, device.costUsd])).toEqual([
      ['MacBook', 5],
      ['iPhone', 1],
    ]);
    expect(felix.devices[0].models.map((model) => model.model)).toEqual([
      'claude-sonnet-5-5',
      'claude-opus-5-5',
    ]);

    expect(unassigned.user).toBe('');
    expect(unassigned.devices.map((device) => [device.fingerprint, device.device])).toEqual([
      ['cccccccccccc', ''],
      ['dddddddddddd', ''],
    ]);
  });

  test('costBetween measures last window at the same elapsed point', () => {
    const buckets = [bucket({ hourMs: 0 }), bucket({ hourMs: HOUR }), bucket({ hourMs: 2 * HOUR })];
    expect(costBetween(buckets, 0, 2 * HOUR)).toBe(2);
  });

  test('user colors are ranked over the whole range and unassigned keeps its own slot', () => {
    const rollups = rollupWindows(
      [
        bucket({ costUsd: 1 }),
        bucket({ fingerprint: 'eeeeeeeeeeee', hourMs: NOW - 8 * 24 * HOUR, costUsd: 9 }),
        bucket({ fingerprint: 'cccccccccccc', costUsd: 50 }),
      ],
      [...clients, { fingerprint: 'eeeeeeeeeeee', device: 'PC', user: 'Ada', configured: true }],
      windows
    );
    const slots = assignUserSlots(rollups);
    expect(slots.get('Ada')).toBe(0);
    expect(slots.get('Felix')).toBe(1);
    expect(slots.get('')).toBe('unassigned');
  });
});

describe('client rows', () => {
  test('match configured keys by sha256 prefix and include keys not seen yet', () => {
    const key = 'sk-device-one';
    const expected = createHash('sha256').update(key).digest('hex').slice(0, 12);
    expect(clientKeyFingerprint(key)).toBe(expected);

    const rows = buildClientRows(
      [
        { fingerprint: expected, device: 'MacBook', user: 'Felix', configured: true },
        { fingerprint: '', device: '', user: '', configured: false },
      ],
      [key, 'sk-unused']
    );
    expect(rows.map((row) => [row.user, row.apiKey])).toEqual([
      ['', 'sk-unused'],
      ['Felix', key],
    ]);
  });
});

test('ledger normalization reads backend field names and drops unparseable hours', () => {
  const ledger = normalizeUsageLedger({
    buckets: [
      { hour: '2026-10-16T11:00:00Z', fingerprint: 'abc', cost_usd: 1.5, input_tokens: 10 },
      { hour: 'not a date', cost_usd: 99 },
    ],
    clients: [{ fingerprint: 'abc', device: 'Mac', user: 'Felix', configured: true }],
    unpriced_models: ['mystery-model'],
  });
  expect(ledger.buckets).toHaveLength(1);
  expect(ledger.buckets[0]).toMatchObject({ hourMs: NOW - HOUR, costUsd: 1.5, inputTokens: 10 });
  expect(ledger.clients[0].user).toBe('Felix');
  expect(ledger.unpricedModels).toEqual(['mystery-model']);
});
