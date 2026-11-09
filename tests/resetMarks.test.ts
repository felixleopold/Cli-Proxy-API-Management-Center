import { describe, expect, test } from 'bun:test';
import { placeResetMarks } from '../src/features/quota/components/resetMarks';

const width = (text: string) => text.length * 6 + 10;
const plot = { left: 48, right: 1200, top: 30, bottom: 210 };

describe('reset marks', () => {
  test('a reset beside two others keeps its pill instead of being dropped', () => {
    // The live case: "Now", a +0.7× reset 18px later and a larger one 40px after it.
    const marks = placeResetMarks(
      [
        { x: 1053, yTo: 150, yFrom: 160, text: '+0.7×', use: 'full', size: 0.7, labelled: true },
        { x: 1075, yTo: 110, yFrom: 148, text: '+2.1×', use: 'low', size: 2.1, labelled: true },
        { x: 1080, yTo: 112, yFrom: 114, text: '+0.2×', use: 'partial', size: 0.2, labelled: true },
      ],
      plot,
      [{ left: 1029, right: 1041, top: 152, bottom: 164 }],
      width,
      16
    );
    expect(marks.every((mark) => mark.pill !== null)).toBe(true);
    const boxes = marks.map(({ pill }) => ({
      left: pill!.x - pill!.width / 2,
      right: pill!.x + pill!.width / 2,
      top: pill!.y - 8,
      bottom: pill!.y + 8,
    }));
    boxes.forEach((box, index) =>
      boxes.slice(index + 1).forEach((other) => {
        const apart =
          box.right <= other.left ||
          other.right <= box.left ||
          box.bottom <= other.top ||
          other.bottom <= box.top;
        expect(apart).toBe(true);
      })
    );
  });
});
