import { describe, expect, test } from 'bun:test';
import {
  budgetState,
  filterKeys,
  groupKeys,
  isValidModelPattern,
  keyStatus,
  summarizeKeys,
  unpricedBlocksKey,
} from '../src/features/clientKeys/clientKeysModel';
import { DEFAULT_VIEW_PREFS, parseViewPrefs } from '../src/features/clientKeys/viewPrefs';
import type { ClientKey } from '../src/services/api/clientKeys';

const NOW = Date.UTC(2026, 9, 15);

const key = (overrides: Partial<ClientKey>): ClientKey => ({
  id: 'k',
  name: 'key',
  project: '',
  prefix: 'cpk_abc',
  createdAtMs: NOW,
  updatedAtMs: NOW,
  expiresAtMs: null,
  disabled: false,
  models: [],
  credentials: 'any',
  monthlyBudgetUsd: 0,
  spentUsdMonth: 0,
  unpricedUsageMonth: false,
  ...overrides,
});

describe('key status', () => {
  test('disabled wins over expired', () => {
    expect(keyStatus(key({ disabled: true, expiresAtMs: NOW - 1 }), NOW)).toBe('disabled');
    expect(keyStatus(key({ expiresAtMs: NOW }), NOW)).toBe('expired');
    expect(keyStatus(key({ expiresAtMs: NOW + 1 }), NOW)).toBe('active');
  });
});

describe('budget state', () => {
  test('levels follow the gateway: near from 80%, over at the budget', () => {
    expect(budgetState(key({ monthlyBudgetUsd: 0, spentUsdMonth: 50 })).level).toBe('unlimited');
    expect(budgetState(key({ monthlyBudgetUsd: 10, spentUsdMonth: null })).level).toBe('untracked');
    expect(budgetState(key({ monthlyBudgetUsd: 10, spentUsdMonth: 7.99 })).level).toBe('ok');
    expect(budgetState(key({ monthlyBudgetUsd: 10, spentUsdMonth: 8 })).level).toBe('near');
    expect(budgetState(key({ monthlyBudgetUsd: 10, spentUsdMonth: 10 })).level).toBe('over');
  });

  test('unpriced usage blocks only budgeted keys', () => {
    expect(unpricedBlocksKey(key({ unpricedUsageMonth: true, monthlyBudgetUsd: 5 }))).toBe(true);
    expect(unpricedBlocksKey(key({ unpricedUsageMonth: true }))).toBe(false);
  });
});

describe('overview', () => {
  test('counts alerts, unpriced keys and budgets', () => {
    const overview = summarizeKeys(
      [
        key({ id: 'a', monthlyBudgetUsd: 10, spentUsdMonth: 12 }),
        key({ id: 'b', monthlyBudgetUsd: 10, spentUsdMonth: 9 }),
        key({ id: 'c', spentUsdMonth: 3, unpricedUsageMonth: true }),
        key({ id: 'd', disabled: true }),
      ],
      NOW
    );
    expect(overview).toMatchObject({
      total: 4,
      spentUsd: 24,
      budgetUsd: 20,
      unlimited: 2,
      near: 1,
      over: 1,
      unpriced: 1,
      byStatus: { active: 3, disabled: 1, expired: 0 },
    });
  });

  test('spend is unknown while the ledger is off', () => {
    expect(summarizeKeys([key({ spentUsdMonth: null })], NOW).spentUsd).toBeNull();
  });
});

describe('filter and grouping', () => {
  const keys = [
    key({ id: '1', name: 'worker', project: 'zeta', spentUsdMonth: 1 }),
    key({ id: '2', name: 'loose', project: '', spentUsdMonth: 2 }),
    key({ id: '3', name: 'web', project: 'alpha', models: ['claude-sonnet-*'] }),
    key({ id: '4', name: 'api', project: 'alpha', spentUsdMonth: 4 }),
  ];

  test('projects sort alphabetically with unassigned keys last', () => {
    const groups = groupKeys(keys, 'project');
    expect(groups.map((group) => group.project)).toEqual(['alpha', 'zeta', '']);
    expect(groups[0].keys.map((item) => item.name)).toEqual(['api', 'web']);
    expect(groups[0].spentUsd).toBe(4);
  });

  test('flat grouping is one group sorted by name', () => {
    const [flat, ...rest] = groupKeys(keys, 'flat');
    expect(rest).toHaveLength(0);
    expect(flat.project).toBeNull();
    expect(flat.keys.map((item) => item.name)).toEqual(['api', 'loose', 'web', 'worker']);
  });

  test('search matches models and the project filter narrows', () => {
    expect(filterKeys(keys, 'SONNET', { kind: 'all' }).map((item) => item.id)).toEqual(['3']);
    expect(filterKeys(keys, '', { kind: 'project', project: '' }).map((item) => item.id)).toEqual([
      '2',
    ]);
  });
});

test('model patterns allow * only at the end', () => {
  expect(isValidModelPattern('claude-*')).toBe(true);
  expect(isValidModelPattern('*-sonnet')).toBe(false);
  expect(isValidModelPattern('')).toBe(false);
});

describe('view prefs', () => {
  test('stored values merge over defaults and junk falls back', () => {
    const prefs = parseViewPrefs(
      JSON.stringify({ grouping: 'flat', columns: { models: false, bogus: true } })
    );
    expect(prefs.grouping).toBe('flat');
    expect(prefs.columns).toEqual({ ...DEFAULT_VIEW_PREFS.columns, models: false });
    expect(parseViewPrefs('{not json')).toEqual(DEFAULT_VIEW_PREFS);
  });
});
