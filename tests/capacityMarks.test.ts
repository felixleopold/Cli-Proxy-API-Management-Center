import { describe, expect, test } from 'bun:test';
import { capacityChips } from '../src/features/quota/components/capacityMarks';

const HOUR_MS = 60 * 60 * 1000;
const width = (text: string) => text.length * 6;
const count = (n: number) => `${n} changes`;

describe('capacity change chips', () => {
  test('changes hours apart on a long axis merge into one chip that counts them', () => {
    // The live case: a retirement and an upgrade 2h50m apart on a 14-day, 1200px axis.
    const pxPerMs = 1200 / (14 * 24 * HOUR_MS);
    const at = 13 * 24 * HOUR_MS;
    const chips = capacityChips(
      [
        { atMs: at, size: 10, delta: '−10×' },
        { atMs: at + 170 * 60 * 1000, size: 4, delta: '+4×' },
      ],
      (t) => t * pxPerMs,
      0,
      1200,
      0.5,
      width,
      count
    );
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({ text: '2 changes', count: 2 });
  });

  test('changes far apart keep their own delta chips', () => {
    const chips = capacityChips(
      [
        { atMs: 100, size: 10, delta: '−10×' },
        { atMs: 900, size: 4, delta: '+4×' },
      ],
      (t) => t,
      0,
      1000,
      0.5,
      width,
      count
    );
    expect(chips.map((chip) => [chip.x, chip.text])).toEqual([
      [100, '−10×'],
      [900, '+4×'],
    ]);
  });

  test('small share tweaks get no chip', () => {
    const chips = capacityChips(
      [{ atMs: 500, size: 0.05, delta: '+0.05×' }],
      (t) => t,
      0,
      1000,
      0.5,
      width,
      count
    );
    expect(chips).toEqual([]);
  });
});
