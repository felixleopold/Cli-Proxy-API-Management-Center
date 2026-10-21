import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  WEEK_MS,
  assignSlots,
  buildClientRows,
  buildTimeBuckets,
  OWN_ACCOUNT_AUTH_ID,
  clientKeyFingerprint,
  credentialKind,
  currentUsedPercent,
  filterBuckets,
  floorToUnit,
  ledgerNeedsReload,
  ledgerStartMs,
  parseSubscription,
  quotaWindowSpan,
  resolveSelection,
  rollupUsers,
  stackByTime,
  summarizeSubscription,
  withHistoryWindow,
  type Subscription,
} from '../src/features/usage/usageModel';
import { normalizeUsageLedger } from '../src/services/api/usageLedger';
import type { UsageLedgerBucket } from '../src/types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-16T12:00:00Z');

const bucket = (overrides: Partial<UsageLedgerBucket>): UsageLedgerBucket => ({
  hourMs: NOW - HOUR,
  fingerprint: 'aaaaaaaaaaaa',
  provider: 'claude',
  authId: 'claude-a',
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

const clients = [
  { fingerprint: 'aaaaaaaaaaaa', device: 'MacBook', user: 'Felix', configured: true },
  { fingerprint: 'bbbbbbbbbbbb', device: 'iPhone', user: 'Felix', configured: true },
  { fingerprint: 'cccccccccccc', device: 'Desktop', user: 'Sam', configured: true },
];

// Claude weekly window resetting 2 days from now, last read an hour ago.
const claude: Subscription = {
  id: 'claude-a',
  provider: 'claude',
  name: 'a@example.com',
  observedAtMs: NOW - HOUR,
  quota: { usedPercent: 40, resetMs: NOW + 2 * DAY, periodMs: WEEK_MS },
  session: null,
};

describe('quota signals', () => {
  test('claude utilization is a fraction and the weekly window leads', () => {
    const subscription = parseSubscription({
      name: 'claude-a.json',
      id: 'claude-a',
      type: 'claude',
      email: 'a@example.com',
      quota: {
        observed_at: '2026-10-16T11:00:00Z',
        signals: {
          'Anthropic-Ratelimit-Unified-5h-Utilization': '0.5',
          'Anthropic-Ratelimit-Unified-5h-Reset': String((NOW + HOUR) / 1000),
          'Anthropic-Ratelimit-Unified-7d-Utilization': '0.25',
          'Anthropic-Ratelimit-Unified-7d-Reset': String((NOW + 2 * DAY) / 1000),
        },
      },
    });
    expect(subscription).toMatchObject({
      id: 'claude-a',
      provider: 'claude',
      name: 'a@example.com',
    });
    expect(subscription.observedAtMs).toBe(NOW - HOUR);
    expect(subscription.quota).toEqual({
      usedPercent: 25,
      resetMs: NOW + 2 * DAY,
      periodMs: WEEK_MS,
    });
    expect(subscription.session).toEqual({
      usedPercent: 50,
      resetMs: NOW + HOUR,
      periodMs: 5 * HOUR,
    });
  });

  test('codex windows come from minutes; reset-after counts from the reading', () => {
    const subscription = parseSubscription({
      name: 'codex.json',
      type: 'codex',
      quota: {
        observed_at: '2026-10-16T11:00:00Z',
        signals: {
          'X-Codex-Primary-Used-Percent': '12',
          'X-Codex-Primary-Window-Minutes': '300',
          'X-Codex-Primary-Reset-After-Seconds': '600',
          'X-Codex-Secondary-Used-Percent': '61',
          'X-Codex-Secondary-Window-Minutes': '10080',
          'X-Codex-Secondary-Reset-At': String((NOW + DAY) / 1000),
        },
      },
    });
    expect(subscription.id).toBe('codex.json');
    expect(subscription.quota).toEqual({ usedPercent: 61, resetMs: NOW + DAY, periodMs: WEEK_MS });
    expect(subscription.session).toEqual({
      usedPercent: 12,
      resetMs: NOW - HOUR + 600_000,
      periodMs: 5 * HOUR,
    });
  });

  test('credentials without signals have no window', () => {
    expect(parseSubscription({ name: 'gemini.json', type: 'gemini' }).quota).toBeNull();
  });
});

describe('quota history fallback', () => {
  const weekly = (atMs: number, resetAtMs: number, usedPercent: number) => ({
    authId: 'claude-a',
    provider: 'claude',
    window: 'weekly' as const,
    windowMinutes: 7 * 24 * 60,
    atMs,
    resetAtMs,
    usedPercent,
  });
  const history = [
    weekly(NOW - 3 * DAY, NOW - 2 * DAY, 30),
    weekly(NOW - 10 * DAY, NOW - 9 * DAY, 80),
    // Newer, but a session window: the weekly one is preferred.
    { ...weekly(NOW - HOUR, NOW + HOUR, 10), window: 'session' as const, windowMinutes: 300 },
    // Another credential's newer weekly reading is ignored.
    { ...weekly(NOW - DAY, NOW + 6 * DAY, 90), authId: 'claude-b' },
  ];

  test('a credential without live signals takes its newest weekly history window', () => {
    const filled = withHistoryWindow({ ...claude, observedAtMs: null, quota: null }, history);
    expect(filled.fromHistory).toBe(true);
    expect(filled.observedAtMs).toBe(NOW - 3 * DAY);
    expect(filled.quota).toEqual({ usedPercent: 30, resetMs: NOW - 2 * DAY, periodMs: WEEK_MS });
    // The stale reset rolls forward into the window containing now.
    expect(quotaWindowSpan(filled.quota!, NOW)).toEqual({
      startMs: NOW - 2 * DAY,
      endMs: NOW + 5 * DAY,
    });
  });

  test('a live window wins over history', () => {
    expect(withHistoryWindow(claude, history)).toBe(claude);
  });
});

describe('quota windows', () => {
  test('a window ends at its reset; a stale reset rolls forward by whole periods', () => {
    expect(quotaWindowSpan(claude.quota!, NOW)).toEqual({
      startMs: NOW + 2 * DAY - WEEK_MS,
      endMs: NOW + 2 * DAY,
    });
    const stale = { ...claude.quota!, resetMs: NOW - 9 * DAY };
    expect(quotaWindowSpan(stale, NOW)).toEqual({ startMs: NOW - 2 * DAY, endMs: NOW + 5 * DAY });
    // The reset instant itself opens the next window.
    expect(quotaWindowSpan(stale, NOW - 2 * DAY).startMs).toBe(NOW - 2 * DAY);
    expect(quotaWindowSpan(stale, NOW, 2)).toEqual({
      startMs: NOW - 16 * DAY,
      endMs: NOW - 9 * DAY,
    });
  });

  test('a reading from before the current window does not count as used', () => {
    expect(currentUsedPercent(claude.quota!, NOW - HOUR, NOW)).toBe(40);
    expect(currentUsedPercent(claude.quota!, NOW - 6 * DAY, NOW)).toBeNull();
    expect(currentUsedPercent(claude.quota!, null, NOW)).toBeNull();
  });
});

describe('selection', () => {
  test('ranges end with the bucket containing now and compare to the period before', () => {
    const selection = resolveSelection({ kind: 'range', range: '24h' }, [], NOW)!;
    expect(selection).toMatchObject({ startMs: NOW - 23 * HOUR, endMs: NOW + HOUR, unit: 'hour' });
    expect(selection.authId).toBeNull();
    // Cut at the same elapsed point: 23h into a 24h span.
    expect(selection.previous).toEqual({ startMs: NOW - 47 * HOUR, endMs: NOW - 24 * HOUR });
  });

  test('a range covers its full duration even when it starts mid-bucket', () => {
    // Monday 00:00 UTC: weekly buckets must not trim 90 days to 84.
    const monday = Date.parse('2026-10-19T00:00:00Z');
    const selection = resolveSelection({ kind: 'range', range: '90d' }, [], monday)!;
    expect(selection.endMs).toBe(monday + HOUR);
    expect(selection.startMs).toBe(monday + HOUR - 90 * DAY);
    const buckets = buildTimeBuckets(selection, selection.unit);
    expect(buckets[0].startMs).toBe(selection.startMs);
    expect(buckets.at(-1)!.endMs).toBe(selection.endMs);
  });

  test('the repeated DST hour still ends the 24h range after the current ledger hour', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'Europe/Vienna';
    try {
      // 02:30 CET, the second 02:00–03:00 on 2026-10-25.
      const at = Date.parse('2026-10-25T01:30:00Z');
      const selection = resolveSelection({ kind: 'range', range: '24h' }, [], at)!;
      expect(selection.endMs).toBe(Date.parse('2026-10-25T02:00:00Z'));
      expect(selection.endMs - selection.startMs).toBe(24 * HOUR);
    } finally {
      process.env.TZ = tz;
    }
  });

  test('fractional-offset zones keep local :00 boundaries for days, weeks and six hours', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'Asia/Kolkata';
    try {
      const at = Date.parse('2026-10-21T15:45:00+05:30');
      for (const unit of ['sixHours', 'day', 'week'] as const) {
        expect(new Date(floorToUnit(at, unit)).getMinutes()).toBe(0);
      }
      expect(new Date(floorToUnit(at, 'sixHours')).getHours()).toBe(12);
      expect(new Date(floorToUnit(at, 'day')).getHours()).toBe(0);
    } finally {
      process.env.TZ = tz;
    }
  });

  test('window mode follows one credential and its previous window at the same point', () => {
    const selection = resolveSelection(
      { kind: 'window', subscriptionId: 'claude-a', stepsBack: 0 },
      [claude],
      NOW,
      NOW - HOUR
    )!;
    const startMs = NOW + 2 * DAY - WEEK_MS;
    expect(selection).toMatchObject({
      startMs,
      endMs: NOW + 2 * DAY,
      unit: 'sixHours',
      authId: 'claude-a',
    });
    // Cut at the snapshot (the ledger's end), not at the clock.
    expect(selection.previous).toEqual({ startMs: startMs - WEEK_MS, endMs: NOW - HOUR - WEEK_MS });
    expect(
      resolveSelection({ kind: 'window', subscriptionId: 'gone', stepsBack: 0 }, [claude], NOW)
    ).toBeNull();
  });

  test('window filtering keeps the credential, including unattributed totals elsewhere', () => {
    const buckets = [
      bucket({ costUsd: 2 }),
      bucket({ authId: 'claude-b', costUsd: 3 }),
      bucket({ authId: '', costUsd: 5 }),
      bucket({ hourMs: NOW - 8 * DAY, costUsd: 7 }),
    ];
    const window = quotaWindowSpan(claude.quota!, NOW);
    expect(filterBuckets(buckets, { ...window, provider: null, authId: 'claude-a' })).toHaveLength(
      1
    );
    const all = filterBuckets(buckets, { ...window, provider: 'claude', authId: null });
    expect(all.map((item) => item.costUsd)).toEqual([2, 3, 5]);
  });
});

describe('ledger snapshot', () => {
  test('covers the history range that windowless cards fall back to while a window is open', () => {
    const window = resolveSelection(
      { kind: 'window', subscriptionId: 'claude-a', stepsBack: 0 },
      [claude],
      NOW
    )!;
    const ninetyDays = resolveSelection({ kind: 'range', range: '90d' }, [claude], NOW)!;
    expect(ledgerStartMs(window, [claude], NOW, ninetyDays)).toBeLessThanOrEqual(
      ninetyDays.startMs
    );
  });

  test('reloads once the clock passes the hour the snapshot ends in', () => {
    const loaded = { startMs: NOW - 14 * DAY, endMs: NOW + 50 * 60_000 };
    expect(ledgerNeedsReload(loaded, NOW - 7 * DAY, NOW + 59 * 60_000)).toBe(false);
    // A window that reset at the hour would otherwise miss everything after it.
    expect(ledgerNeedsReload(loaded, NOW - 7 * DAY, NOW + HOUR + 60_000)).toBe(true);
    expect(ledgerNeedsReload(loaded, NOW - 30 * DAY, NOW)).toBe(true);
    expect(ledgerNeedsReload(null, NOW - 7 * DAY, NOW)).toBe(true);
  });
});

describe('serving credentials', () => {
  test('pre-tracking and imported personal usage are not removed credentials', () => {
    const known = new Set(['claude-a']);
    expect(credentialKind('', known)).toBe('pre_tracking');
    expect(credentialKind(OWN_ACCOUNT_AUTH_ID, known)).toBe('own_account');
    expect(credentialKind('claude-a', known)).toBe('subscription');
    expect(credentialKind('claude-gone', known)).toBe('removed');
  });
});

describe('rollups', () => {
  test('groups by user, device and model; unlabelled keys are unassigned', () => {
    const rollup = rollupUsers(
      [
        bucket({ costUsd: 2 }),
        bucket({ costUsd: 3, model: 'claude-sonnet-5-5' }),
        bucket({ fingerprint: 'bbbbbbbbbbbb', costUsd: 1 }),
        bucket({ fingerprint: 'dddddddddddd', costUsd: 0.5 }),
      ],
      clients
    );
    expect(rollup.costUsd).toBe(6.5);
    expect(rollup.tokens).toBe(4 * 150);
    const [felix, unassigned] = rollup.users;
    expect(felix.devices.map((device) => [device.device, device.costUsd])).toEqual([
      ['MacBook', 5],
      ['iPhone', 1],
    ]);
    expect(felix.devices[0].models.map((model) => model.model)).toEqual([
      'claude-sonnet-5-5',
      'claude-opus-5-5',
    ]);
    expect(unassigned.user).toBe('');
  });

  test('time buckets clip to the span and stack spend by series', () => {
    const span = { startMs: NOW - 90 * 60_000, endMs: NOW + HOUR };
    const spans = buildTimeBuckets(span, 'hour');
    expect(spans).toEqual([
      { startMs: span.startMs, endMs: NOW - HOUR },
      { startMs: NOW - HOUR, endMs: NOW },
      { startMs: NOW, endMs: NOW + HOUR },
    ]);
    const stacked = stackByTime(
      [
        bucket({ costUsd: 2 }),
        bucket({ fingerprint: 'cccccccccccc', costUsd: 3 }),
        bucket({ hourMs: NOW }),
      ],
      spans,
      (item) => item.fingerprint
    );
    expect(stacked.map((item) => item.total)).toEqual([0, 5, 1]);
    expect(stacked[1].values.get('cccccccccccc')).toBe(3);
  });

  test('subscription summary splits the window by user and extrapolates from the reading', () => {
    const summary = summarizeSubscription(
      claude,
      [
        bucket({ hourMs: NOW - 2 * HOUR, costUsd: 6 }),
        bucket({ hourMs: NOW - 3 * HOUR, fingerprint: 'cccccccccccc', costUsd: 2 }),
        // After the reading: counted as spend, not in the estimate.
        bucket({ hourMs: NOW, costUsd: 4 }),
        bucket({ authId: 'claude-b', costUsd: 50 }),
      ],
      clients,
      NOW,
      { startMs: 0, endMs: 0 }
    );
    expect(summary.costUsd).toBe(12);
    expect(summary.users).toEqual([
      { user: 'Felix', costUsd: 10 },
      { user: 'Sam', costUsd: 2 },
    ]);
    expect(summary.usedPercent).toBe(40);
    expect(summary.estimateUsd).toBe(20);

    const barely = { ...claude, quota: { ...claude.quota!, usedPercent: 4 } };
    expect(
      summarizeSubscription(barely, [bucket({})], clients, NOW, claude.quota!).estimateUsd
    ).toBeNull();
  });

  test('slots follow identity order, keep "" as none and fold past seven', () => {
    const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const slots = assignSlots(keys);
    expect(slots.get('')).toBe('none');
    expect(slots.get('a')).toBe(0);
    expect(slots.get('g')).toBe(6);
    expect(slots.get('h')).toBe('other');
    expect(assignSlots(['a', 'c']).get('c')).toBe(1);
  });
});

describe('client rows', () => {
  test('fingerprints trim the key like Go and skip empty keys', () => {
    const expected = createHash('sha256').update('sk-device-one').digest('hex').slice(0, 12);
    expect(clientKeyFingerprint('  sk-device-one\n')).toBe(expected);
    expect(clientKeyFingerprint('   ')).toBe('');
    expect(buildClientRows([], ['', '  ']).map((row) => row.fingerprint)).toEqual([]);
  });

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
  const ledger = normalizeUsageLedger(
    {
      to: '2026-10-16T12:00:00Z',
      buckets: [
        {
          hour: '2026-10-16T11:00:00Z',
          fingerprint: 'abc',
          auth_id: 'claude-a',
          cost_usd: 1.5,
          input_tokens: 10,
        },
        { hour: 'not a date', cost_usd: 99 },
      ],
      clients: [{ fingerprint: 'abc', device: 'Mac', user: 'Felix', configured: true }],
      unpriced_models: ['mystery-model'],
    },
    0
  );
  expect(ledger.toMs).toBe(NOW);
  expect(normalizeUsageLedger({}, 42).toMs).toBe(42);
  expect(ledger.buckets).toHaveLength(1);
  expect(ledger.buckets[0]).toMatchObject({
    hourMs: NOW - HOUR,
    authId: 'claude-a',
    costUsd: 1.5,
    inputTokens: 10,
  });
  expect(ledger.clients[0].user).toBe('Felix');
  expect(ledger.unpricedModels).toEqual(['mystery-model']);
});
