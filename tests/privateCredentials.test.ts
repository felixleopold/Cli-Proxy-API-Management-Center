import { describe, expect, test } from 'bun:test';
import {
  splitPrivateCredentials,
  withoutPrivate,
  withoutPrivateHistory,
} from '../src/features/quota/privateCredentials';
import {
  buildAuthFileFieldsPatch,
  type PrefixProxyEditorState,
} from '../src/features/authFiles/hooks/useAuthFilesPrefixProxyEditor';
import type { UsageLedgerBucket } from '../src/types';
import { unpricedModels } from '../src/features/usage/usageModel';
import { normalizeAuthFilesResponse } from '../src/services/api/authFiles';
import type { QuotaHistoryState } from '../src/features/quota/hooks/useQuotaHistory';
import type { CapacityEntry } from '../src/services/api/capacityHistory';
import type { QuotaHistorySample } from '../src/services/api/quotaHistory';

const sample = (authId: string): QuotaHistorySample => ({
  atMs: 1,
  authId,
  provider: 'claude',
  window: 'weekly',
  windowMinutes: 10080,
  usedPercent: 10,
  resetAtMs: 2,
});

const entry = (authId: string) => ({ atMs: 1, authId }) as CapacityEntry;

const bucket = (authId: string) =>
  ({ hourMs: 1, provider: 'claude', authId, costUsd: 5 }) as UsageLedgerBucket;

describe('private credentials on Usage & quota', () => {
  test('the listing carries private_user, and the page keeps only shared credentials', () => {
    const { files } = normalizeAuthFilesResponse({
      files: [
        { id: 'claude-shared', name: 'shared.json', type: 'claude' },
        { id: 'claude-mine', name: 'mine.json', type: 'claude', private_user: ' Felix ' },
      ],
    });
    expect(files.find((file) => file.id === 'claude-mine')?.privateUser).toBe('Felix');
    const { shared, privateIds } = splitPrivateCredentials(files);
    expect(shared.map((file) => file.id)).toEqual(['claude-shared']);
    expect([...privateIds]).toEqual(['claude-mine']);
  });

  test('their samples and capacity timeline entries leave the shared history', () => {
    const history: QuotaHistoryState = {
      status: 'ok',
      samples: [sample('claude-shared'), sample('claude-mine')],
      forecastSamples: [sample('claude-mine')],
      ledger: [bucket('claude-mine'), bucket('claude-shared')],
      capacity: [entry('claude-mine'), entry('claude-shared')],
    };
    const filtered = withoutPrivateHistory(history, new Set(['claude-mine']));
    expect(filtered).toMatchObject({
      samples: [{ authId: 'claude-shared' }],
      forecastSamples: [],
      ledger: [{ authId: 'claude-shared' }],
      capacity: [{ authId: 'claude-shared' }],
    });
    // Without private credentials the history is passed through as is.
    expect(withoutPrivateHistory(history, new Set())).toBe(history);
  });

  test('spend from before a credential was made private stays out of the spend history', () => {
    const buckets = [bucket('claude-mine'), bucket('claude-shared'), bucket('')];
    expect(withoutPrivate(buckets, new Set(['claude-mine'])).map((b) => b.authId)).toEqual([
      'claude-shared',
      '',
    ]);
  });
});

test('a model only a private credential used is not named as unpriced', () => {
  const unpriced = (authId: string, model: string) =>
    ({ ...bucket(authId), model, priced: false }) as UsageLedgerBucket;
  const buckets = [unpriced('claude-mine', 'secret-model'), unpriced('claude-shared', 'grok-4.7')];
  expect(unpricedModels(buckets)).toEqual(['grok-4.7', 'secret-model']);
  expect(unpricedModels(withoutPrivate(buckets, new Set(['claude-mine'])))).toEqual(['grok-4.7']);
});

describe('private user field on the credential sheet', () => {
  // Kimi has no usage-cap fields: the private user must still be patched.
  const editor = (json: Record<string, unknown>, privateUser: string) =>
    ({
      json,
      providerKey: 'kimi',
      prefix: '',
      proxyUrl: '',
      priority: '',
      weight: '',
      usageCapPercent: '',
      planMultiplier: '',
      plan: '',
      lender: '',
      privateUser,
      reserveFiveHour: '',
      reserveWeekly: '',
    }) as PrefixProxyEditorState;
  const patch = (json: Record<string, unknown>, privateUser: string) =>
    buildAuthFileFieldsPatch(editor(json, privateUser), (key) => key);

  test('sets it on a provider without usage-cap support', () => {
    expect(patch({}, ' Felix ')).toEqual({ private_user: 'Felix' });
  });

  test('clears it with null', () => {
    expect(patch({ private_user: 'Felix' }, '')).toEqual({ private_user: null });
  });

  test('leaves an unchanged value out of the patch', () => {
    expect(patch({ private_user: 'Felix' }, 'Felix')).toEqual({});
    expect(patch({}, '')).toEqual({});
  });
});
