import { describe, expect, test } from 'bun:test';
import {
  FABLE_MODEL_ID,
  FABLE_ROUTE_ANY,
  FABLE_ROUTE_SEVERAL,
  applyFilePatch,
  fableRoutePatches,
  fableRouteValue,
} from '@/features/quota/fableRoute';
import type { AuthFileItem } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';

const files = [
  { name: 'a.json', preferredModels: [FABLE_MODEL_ID, 'claude-opus-5-5'] },
  { name: 'b.json', preferredModels: [FABLE_MODEL_ID] },
  { name: 'c.json' },
];

describe('Fable route patches', () => {
  test('adds to the target keeping its entries and removes from every other holder', () => {
    expect(fableRoutePatches(files, 'c.json')).toEqual([
      // The target's addition comes first, so a failed save never leaves Fable on no account.
      { name: 'c.json', fields: { preferred_models: [FABLE_MODEL_ID] } },
      { name: 'a.json', fields: { preferred_models: ['claude-opus-5-5'] } },
      { name: 'b.json', fields: { preferred_models: null } },
    ]);
  });

  test('"Any account" only removes, and a settled route patches nothing', () => {
    expect(fableRoutePatches(files, FABLE_ROUTE_ANY).map((patch) => patch.name)).toEqual([
      'a.json',
      'b.json',
    ]);
    expect(fableRoutePatches([files[1], files[2]], 'b.json')).toEqual([]);
  });

  test('reads none, one or several holders', () => {
    expect(fableRouteValue([files[2]])).toBe(FABLE_ROUTE_ANY);
    expect(fableRouteValue([files[1], files[2]])).toBe('b.json');
    expect(fableRouteValue(files)).toBe(FABLE_ROUTE_SEVERAL);
  });
});

describe('applyFilePatch', () => {
  const listed = (name: string, fableLocked?: true): AuthFileItem =>
    ({ name, type: 'claude', ...(fableLocked ? { fableLocked } : {}) }) as AuthFileItem;
  const holders = (files: AuthFileItem[]) =>
    files.filter((file) => file.fableLocked).map((file) => file.name);

  test('locking one account unlocks the previous holder', () => {
    const files = [listed('a.json', true), listed('b.json')];
    const key = getQuotaCacheKey(files[1]);
    expect(holders(applyFilePatch(files, key, { fableLocked: true }))).toEqual(['b.json']);
  });

  test('an unlock leaves no holder', () => {
    const files = [listed('a.json', true), listed('b.json', true)];
    const key = getQuotaCacheKey(files[0]);
    expect(holders(applyFilePatch(files, key, { fableLocked: undefined }))).toEqual([]);
  });

  test('other patches leave the lock alone', () => {
    const files = [listed('a.json', true), listed('b.json')];
    const key = getQuotaCacheKey(files[1]);
    expect(holders(applyFilePatch(files, key, { disabled: true }))).toEqual(['a.json']);
  });
});
