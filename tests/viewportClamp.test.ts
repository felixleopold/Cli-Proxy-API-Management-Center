import { describe, expect, test } from 'bun:test';
import { shiftIntoBounds } from '../src/features/quota/components/viewportClamp';

// A 360px phone whose content column clips at 20..340.
const MIN = 20;
const MAX = 340;

describe('shiftIntoBounds', () => {
  test('leaves a popover that fits where it opened', () => {
    expect(shiftIntoBounds(40, 272, MIN, MAX)).toBe(0);
  });

  test('pushes a right-aligned menu that opened past the left edge back inside', () => {
    // A pace button near the left edge, menu aligned to its right edge.
    expect(shiftIntoBounds(-140, 272, MIN, MAX)).toBe(160);
  });

  test('pulls a left-aligned menu that ran past the right edge back inside', () => {
    // A reserves chip on the right, menu aligned to its left edge.
    expect(shiftIntoBounds(200, 272, MIN, MAX)).toBe(-132);
  });

  test('pins a box wider than the room to its start', () => {
    expect(shiftIntoBounds(60, 400, MIN, MAX)).toBe(-40);
  });
});
