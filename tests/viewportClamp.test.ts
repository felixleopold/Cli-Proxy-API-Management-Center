import { describe, expect, test } from 'bun:test';
import { shiftIntoBounds, verticalFit } from '../src/features/quota/components/viewportClamp';

// A 360px phone whose content column clips at 20..340.
const MIN = 20;
const MAX = 340;

describe('shiftIntoBounds', () => {
  test('pins a box wider than the room to its start', () => {
    expect(shiftIntoBounds(60, 400, MIN, MAX)).toBe(-40);
  });
});

describe('verticalFit', () => {
  test('stays below when the popover fits', () => {
    expect(verticalFit(100, 140, 260, 667)).toEqual({ placement: 'below', maxHeight: null });
  });

  test('flips above and caps height when opened near the bottom of a short screen', () => {
    expect(verticalFit(560, 600, 620, 667)).toEqual({ placement: 'above', maxHeight: 546 });
  });
});
