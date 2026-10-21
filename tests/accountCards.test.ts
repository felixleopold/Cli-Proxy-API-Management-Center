import { describe, expect, test } from 'bun:test';
import { pairAccountSpend } from '@/features/quota/accountCards';
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

const entries = classifyQuotaFiles([
  // The ledger's auth_id is Auth.ID when the gateway reports one, else the file name.
  file('claude-alice.json', 'claude', { id: 'auth-alice', email: 'alice@example.com' }),
  file('codex-carol.json', 'codex', { email: 'carol@example.com' }),
  file('codex-dave.json', 'codex', { email: 'dave@example.com' }),
]);

const summaries = [
  summary('codex-carol.json', 'codex', 'carol@example.com'),
  summary('gemini-erin.json', 'gemini', 'erin@example.com'),
  summary('auth-alice', 'claude', 'alice@example.com'),
  summary('vertex-frank.json', 'vertex', 'frank@example.com'),
];

describe('account card pairing', () => {
  test('pairs each quota card with its spend by auth id, falling back to the file name', () => {
    const { spendFor } = pairAccountSpend(entries, summaries, '');
    expect(entries.map((entry) => spendFor(entry)?.subscription.name ?? null)).toEqual([
      'alice@example.com',
      'carol@example.com',
      null,
    ]);
  });

  test('gives spend without a quota card its own card, in summary order', () => {
    const { spendOnly } = pairAccountSpend(entries, summaries, '');
    expect(spendOnly.map((item) => item.subscription.id)).toEqual([
      'gemini-erin.json',
      'vertex-frank.json',
    ]);
  });

  test('searches spend-only cards, and never turns a hidden quota card into one', () => {
    const { spendOnly } = pairAccountSpend(entries, summaries, 'ERIN');
    expect(spendOnly.map((item) => item.subscription.id)).toEqual(['gemini-erin.json']);
    expect(pairAccountSpend(entries, summaries, 'carol').spendOnly).toEqual([]);
  });
});
