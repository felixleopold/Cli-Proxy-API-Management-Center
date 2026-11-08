/**
 * Capacity change chips on the forecast chart. Every change is a dot on the
 * capacity line; only meaningful ones also get a short delta chip ("−10×") in the
 * lane above the plot. Chips that would touch merge into one that counts them;
 * the tooltip lists every change near the pointer.
 */

export interface ChipInput {
  atMs: number;
  /** Size of the step, in plan multipliers. */
  size: number;
  /** "−10×". */
  delta: string;
}

export interface CapacityChip {
  /** Centre, in pixels. */
  x: number;
  text: string;
  /** Changes it stands for. */
  count: number;
}

/** Space kept between two chips. */
const CHIP_GAP_PX = 6;

/**
 * Chips for the changes of at least `minSize` inside [left, right], left to
 * right. A chip that would cover `keepClear` (the "Now" label) moves to its left
 * first; then a chip that would overlap its neighbour, where it ends up, merges
 * with it, centred on its changes and labelled by `countText`, until none overlap.
 */
export function capacityChips(
  marks: readonly ChipInput[],
  x: (t: number) => number,
  left: number,
  right: number,
  minSize: number,
  widthOf: (text: string) => number,
  countText: (count: number) => string,
  keepClear?: { from: number; to: number }
): CapacityChip[] {
  const groups = marks
    .filter((mark) => mark.size >= minSize)
    .map((mark) => ({ xs: [x(mark.atMs)], delta: mark.delta }))
    .filter(({ xs }) => xs[0] >= left && xs[0] <= right)
    .sort((a, b) => a.xs[0] - b.xs[0]);
  const chip = (group: { xs: number[]; delta: string }): CapacityChip => {
    const text = group.xs.length === 1 ? group.delta : countText(group.xs.length);
    const half = widthOf(text) / 2;
    const centre = group.xs.reduce((sum, value) => sum + value, 0) / group.xs.length;
    const covers =
      keepClear !== undefined && centre + half > keepClear.from && centre - half < keepClear.to;
    return {
      x: covers ? Math.max(left + half, keepClear.from - half) : centre,
      text,
      count: group.xs.length,
    };
  };
  // A chip moved off keepClear can land on (or past) its left neighbour.
  const overlaps = (a: CapacityChip, b: CapacityChip) =>
    Math.abs(b.x - a.x) < (widthOf(a.text) + widthOf(b.text)) / 2 + CHIP_GAP_PX;
  for (let index = 1; index < groups.length;) {
    if (overlaps(chip(groups[index - 1]), chip(groups[index]))) {
      groups[index - 1].xs.push(...groups[index].xs);
      groups.splice(index, 1);
      index = Math.max(1, index - 1);
    } else {
      index += 1;
    }
  }
  return groups.map(chip);
}
