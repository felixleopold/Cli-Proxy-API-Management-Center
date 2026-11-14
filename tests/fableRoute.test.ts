import { describe, expect, test } from 'bun:test';
import {
  FABLE_MODEL_ID,
  FABLE_ROUTE_ANY,
  FABLE_ROUTE_SEVERAL,
  fableRoutePatches,
  fableRouteValue,
} from '@/features/quota/fableRoute';

const files = [
  { name: 'a.json', preferredModels: [FABLE_MODEL_ID, 'claude-opus-5-5'] },
  { name: 'b.json', preferredModels: [FABLE_MODEL_ID] },
  { name: 'c.json' },
];

describe('Fable route patches', () => {
  test('adds to the target keeping its entries and removes from every other holder', () => {
    expect(fableRoutePatches(files, 'c.json')).toEqual([
      { name: 'a.json', fields: { preferred_models: ['claude-opus-5-5'] } },
      { name: 'b.json', fields: { preferred_models: null } },
      { name: 'c.json', fields: { preferred_models: [FABLE_MODEL_ID] } },
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
