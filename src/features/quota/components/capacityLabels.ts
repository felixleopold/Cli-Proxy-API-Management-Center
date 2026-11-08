/** Placement of capacity change pills along the top of the forecast chart. */

export interface CapacityLabelInput {
  atMs: number;
  label: string;
  delta: string;
}

export interface CapacityLabel {
  /** Marker line. */
  x: number;
  /** Pill centre. */
  cx: number;
  /** Stacking row from the top of the plot, 0 first. */
  row: number;
  text: string;
}

/** Space kept between two pills in one row. */
const PILL_GAP_PX = 4;

/**
 * Each pill centred on its marker where it fits in the plot; one that would
 * overlap a pill already in a row drops to the first row where it fits, so
 * changes close together all stay readable.
 */
export function placeCapacityLabels(
  marks: readonly CapacityLabelInput[],
  x: (t: number) => number,
  left: number,
  right: number,
  pillWidth: (text: string) => number
): CapacityLabel[] {
  const rows: { from: number; to: number }[][] = [];
  return marks.flatMap((mark) => {
    const markX = x(mark.atMs);
    if (markX < left || markX > right) return [];
    const text = `${mark.label} ${mark.delta}`;
    const half = pillWidth(text) / 2;
    const cx = Math.min(right - half, Math.max(left + half, markX));
    const fits = (spots: { from: number; to: number }[]) =>
      spots.every(
        (spot) => cx + half + PILL_GAP_PX <= spot.from || cx - half - PILL_GAP_PX >= spot.to
      );
    let row = rows.findIndex(fits);
    if (row < 0) row = rows.push([]) - 1;
    rows[row].push({ from: cx - half, to: cx + half });
    return [{ x: markX, cx, row, text }];
  });
}
