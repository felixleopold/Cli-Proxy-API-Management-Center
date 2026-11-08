import { describe, expect, test } from 'bun:test';
import { readTallCharts, writeTallChart } from '../src/features/quota/tallCharts';

const memory = () => {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
};

describe('taller charts', () => {
  test('remembers each chart kind on its own', () => {
    const storage = memory();
    writeTallChart('forecast', true, storage);
    writeTallChart('spend', true, storage);
    writeTallChart('spend', false, storage);
    expect([...readTallCharts(storage)]).toEqual(['forecast']);
  });

  test('works without storage, or with broken or foreign values', () => {
    expect(readTallCharts(null).size).toBe(0);
    const broken = { getItem: () => '{not json', setItem: () => undefined };
    expect(readTallCharts(broken).size).toBe(0);
    const foreign = { getItem: () => '["forecast","sideways"]', setItem: () => undefined };
    expect([...readTallCharts(foreign)]).toEqual(['forecast']);
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(() => writeTallChart('drain', true, full)).not.toThrow();
  });
});
