import { describe, expect, test } from 'bun:test';
import { clampShift } from '@/components/ui/HoverCard/clampShift';

describe('HoverCard viewport clamp', () => {
  test('leaves a card that fits alone', () => {
    expect(clampShift(20, 300, 360)).toBe(0);
  });

  test('pulls a card back from the right edge of a 360px screen', () => {
    expect(clampShift(200, 480, 360)).toBe(-128);
  });

  test('pushes a card back from the left edge', () => {
    expect(clampShift(-60, 220, 360)).toBe(68);
  });
});
