import { describe, expect, test } from 'bun:test';
import {
  splitPrivateCredentials,
  withoutPrivateHistory,
} from '../src/features/quota/privateCredentials';
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
      ledger: null,
      capacity: [entry('claude-mine'), entry('claude-shared')],
    };
    const filtered = withoutPrivateHistory(history, new Set(['claude-mine']));
    expect(filtered).toMatchObject({
      samples: [{ authId: 'claude-shared' }],
      forecastSamples: [],
      capacity: [{ authId: 'claude-shared' }],
    });
    // Without private credentials the history is passed through as is.
    expect(withoutPrivateHistory(history, new Set())).toBe(history);
  });
});
