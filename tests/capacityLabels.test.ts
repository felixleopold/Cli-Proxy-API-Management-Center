import { describe, expect, test } from 'bun:test';
import { placeCapacityLabels } from '../src/features/quota/components/capacityLabels';

const HOUR_MS = 60 * 60 * 1000;

describe('capacity change pills', () => {
  test('two changes hours apart on a long axis both stay visible, stacked', () => {
    // A 14-day axis over 1200px: 2h50m apart is about 10px, far less than a pill.
    const fromMs = 0;
    const pxPerMs = 1200 / (14 * 24 * HOUR_MS);
    const retiredAt = 13 * 24 * HOUR_MS;
    const labels = placeCapacityLabels(
      [
        { atMs: retiredAt, label: 'felixmrak@gmail.com retired', delta: '−10×' },
        { atMs: retiredAt + 170 * 60 * 1000, label: 'agents@f-squared.at → 5×', delta: '+4×' },
      ],
      (t) => 48 + (t - fromMs) * pxPerMs,
      48,
      1248,
      (text) => Math.round(text.length * 6.5 + 12)
    );
    expect(labels.map((label) => [label.text, label.row])).toEqual([
      ['felixmrak@gmail.com retired −10×', 0],
      ['agents@f-squared.at → 5× +4×', 1],
    ]);
  });

  test('changes far apart share the top row', () => {
    const labels = placeCapacityLabels(
      [
        { atMs: 100, label: 'a', delta: '+1×' },
        { atMs: 900, label: 'b', delta: '+1×' },
      ],
      (t) => t,
      0,
      1000,
      () => 40
    );
    expect(labels.map((label) => label.row)).toEqual([0, 0]);
  });
});
