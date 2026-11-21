import { describe, expect, test } from 'bun:test';
import { pairAccountSpend, pooledByAuthId, windowsForFile } from '@/features/quota/accountCards';
import { requiresVerification } from '@/features/authFiles/verification';
import { buildPools, cardReading } from '@/features/quota/quotaForecastModel';
import { buildAntigravityQuotaGroups } from '@/utils/quota/builders';
import { classifyQuotaFiles } from '@/features/quota/logic';
import type { SubscriptionSummary } from '@/features/usage/usageModel';
import type { AuthFileItem } from '@/types';

const file = (name: string, provider: string, extra: Partial<AuthFileItem> = {}): AuthFileItem =>
  ({ name, provider, ...extra }) as AuthFileItem;

const summary = (id: string, provider: string, name: string): SubscriptionSummary => ({
  subscription: { id, provider, name, observedAtMs: null, quota: null, session: null },
  window: null,
  usedPercent: null,
  sessionUsedPercent: null,
  costUsd: 1,
  users: [],
  estimateUsd: null,
});

const files = [
  // The ledger's auth_id is Auth.ID when the gateway reports one, else the file name.
  file('claude-alice.json', 'claude', { id: 'auth-alice', email: 'alice@example.com' }),
  file('codex-carol.json', 'codex', { email: 'carol@example.com' }),
  file('codex-dave.json', 'codex', { email: 'dave@example.com' }),
  file('gemini-work.json', 'gemini', { id: 'opaque-auth-id', email: 'gina@example.com' }),
];
const entries = classifyQuotaFiles(files);

const summaries = [
  summary('codex-carol.json', 'codex', 'carol@example.com'),
  summary('gemini-erin.json', 'gemini', 'erin@example.com'),
  summary('auth-alice', 'claude', 'alice@example.com'),
  summary('vertex-frank.json', 'vertex', 'frank@example.com'),
  summary('opaque-auth-id', 'gemini', 'gina@example.com'),
];

describe('account card pairing', () => {
  test('pairs each quota card with its spend by auth id, falling back to the file name', () => {
    const { spendFor } = pairAccountSpend(entries, summaries, '', files);
    expect(entries.map((entry) => spendFor(entry)?.subscription.name ?? null)).toEqual([
      'alice@example.com',
      'carol@example.com',
      null,
    ]);
  });

  test('gives spend without a quota card its own card, in summary order', () => {
    const { spendOnly } = pairAccountSpend(entries, summaries, '', files);
    expect(spendOnly.map((item) => item.subscription.id)).toEqual([
      'gemini-erin.json',
      'vertex-frank.json',
      'opaque-auth-id',
    ]);
  });

  test('searches spend-only cards, and never turns a hidden quota card into one', () => {
    const { spendOnly } = pairAccountSpend(entries, summaries, 'ERIN', files);
    expect(spendOnly.map((item) => item.subscription.id)).toEqual(['gemini-erin.json']);
    expect(pairAccountSpend(entries, summaries, 'carol', files).spendOnly).toEqual([]);
  });

  test('finds a spend-only card by its file name when its auth id is opaque', () => {
    const { spendOnly } = pairAccountSpend(entries, summaries, 'gemini-work', files);
    expect(spendOnly.map((item) => item.subscription.id)).toEqual(['opaque-auth-id']);
  });
});

describe('account row quota and status', () => {
  test('Antigravity reads live Gemini 5h and falls back to its exhausted weekly bucket', () => {
    const now = Date.UTC(2026, 9, 17, 12);
    const shortReset = Date.UTC(2026, 9, 17, 15);
    const weeklyReset = Date.UTC(2026, 9, 22);
    const resetTime = new Date(weeklyReset).toISOString();
    const groups = buildAntigravityQuotaGroups({
      groups: [
        {
          displayName: 'Claude and GPT models',
          buckets: [
            { bucketId: 'claude-weekly', window: 'weekly', remainingFraction: 0.8, resetTime },
          ],
        },
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'gemini-5h',
              window: '5h',
              remainingFraction: 0.9,
              resetTime: new Date(shortReset).toISOString(),
            },
            { bucketId: 'gemini-weekly', window: 'weekly', resetTime },
          ],
        },
        {
          displayName: 'Argon Models',
          buckets: [
            { bucketId: 'argon-weekly', window: 'weekly', remainingFraction: 1, resetTime },
          ],
        },
      ],
    });
    expect(groups.map(({ id }) => id)).toEqual(['gemini-models']);
    expect(groups[0].buckets.map(({ id, remainingFraction }) => [id, remainingFraction])).toEqual([
      ['gemini-5h', 0.9],
      ['gemini-weekly', 0],
    ]);

    const credential = file('antigravity.json', 'antigravity', {
      id: 'a',
      quota: {
        observed_at: new Date(now - 1000).toISOString(),
        signals: {
          'X-Antigravity-Gemini-5h-Used-Percent': '75',
          'X-Antigravity-Gemini-5h-Reset-At': String(shortReset / 1000),
        },
      },
    });
    const quota = { status: 'success', fetchedAtMs: now, groups };
    const readings = new Map([['a', cardReading('antigravity', quota)!]]);
    const pooled = pooledByAuthId(buildPools([credential], [], readings));
    expect(windowsForFile(credential, pooled, readings, now)).toMatchObject({
      short: { leftPercent: 25, resetAtMs: shortReset },
      long: { leftPercent: 0, resetAtMs: weeklyReset },
    });
    expect(
      windowsForFile({ ...credential, quota: undefined }, new Map(), readings, now)
    ).toMatchObject({
      short: { leftPercent: 90, resetAtMs: shortReset },
      long: { leftPercent: 0, resetAtMs: weeklyReset },
    });
  });

  test('recognizes verification required in the credential status or cooldown reason', () => {
    const base = file('antigravity.json', 'antigravity');
    expect(requiresVerification({ ...base, statusMessage: 'verification_required' })).toBe(true);
    expect(
      requiresVerification({
        ...base,
        cooldownSnapshot: {
          receivedAtMs: 0,
          records: [
            {
              scope: 'credential',
              retryAt: '',
              remainingSeconds: 60,
              reason: 'verification_required',
            },
          ],
        },
      })
    ).toBe(true);
    expect(
      requiresVerification({
        ...base,
        routingStatus: { state: 'error', reason: 'other' },
      })
    ).toBe(false);
  });
});
