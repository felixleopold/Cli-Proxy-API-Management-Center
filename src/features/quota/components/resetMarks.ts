/**
 * Reset markers on the remaining chart. Every reset gets a dot on its step,
 * coloured by how fully it was used, so even a reset that gave back almost
 * nothing shows. Its "+0.9×" pill then takes the first free slot beside the
 * dot: just above the step, stacked higher, then below it. A pill that fits
 * nowhere is left out; the dot and its tooltip stay.
 */

import type { ResetUse } from '../quotaForecastModel';

export interface ResetMarkInput {
  x: number;
  /** Line y just after the step (its top) and just before it (its bottom), in pixels. */
  yTo: number;
  yFrom: number;
  text: string;
  /** Null for a step that is no reset (an account joining). */
  use: ResetUse | null;
  /** Larger steps claim room first. */
  size: number;
  /** Whether to try a pill; the dot is always drawn. */
  labelled: boolean;
}

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface ResetMark extends ResetMarkInput {
  /** Centre of the pill and its width, or null when none fits. */
  pill: { x: number; y: number; width: number } | null;
}

/** Room between a dot and its pill, and between stacked pills. */
const DOT_GAP_PX = 5;
const ROW_GAP_PX = 3;
/** Space kept between two pills side by side. */
const SIDE_GAP_PX = 4;
export const RESET_DOT_RADIUS = 3;

const overlaps = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Places the pills inside `plot`, clear of each other, of every reset dot and of
 * `obstacles` (e.g. the current-value dot). Returns the marks in input order.
 */
export function placeResetMarks(
  marks: ResetMarkInput[],
  plot: Box,
  obstacles: Box[],
  pillWidth: (text: string) => number,
  pillHeight: number
): ResetMark[] {
  const dot = RESET_DOT_RADIUS + 1;
  const taken: Box[] = [
    ...obstacles,
    ...marks.map((mark) => ({
      left: mark.x - dot,
      right: mark.x + dot,
      top: mark.yTo - dot,
      bottom: mark.yTo + dot,
    })),
  ];
  const step = pillHeight + ROW_GAP_PX;
  const placed = new Map<ResetMarkInput, ResetMark['pill']>();
  [...marks]
    .filter((mark) => mark.labelled)
    .sort((left, right) => right.size - left.size)
    .forEach((mark) => {
      const width = pillWidth(mark.text);
      const x = Math.min(plot.right - width / 2, Math.max(plot.left + width / 2, mark.x));
      const above = mark.yTo - RESET_DOT_RADIUS - DOT_GAP_PX - pillHeight / 2;
      const below = mark.yFrom + RESET_DOT_RADIUS + DOT_GAP_PX + pillHeight / 2;
      const slots = [above, above - step, above - 2 * step, below, below + step];
      const y = slots.find((center) => {
        const box = {
          left: x - width / 2 - SIDE_GAP_PX / 2,
          right: x + width / 2 + SIDE_GAP_PX / 2,
          top: center - pillHeight / 2,
          bottom: center + pillHeight / 2,
        };
        return (
          box.top >= plot.top &&
          box.bottom <= plot.bottom &&
          taken.every((other) => !overlaps(box, other))
        );
      });
      if (y === undefined) return;
      taken.push({
        left: x - width / 2 - SIDE_GAP_PX / 2,
        right: x + width / 2 + SIDE_GAP_PX / 2,
        top: y - pillHeight / 2,
        bottom: y + pillHeight / 2,
      });
      placed.set(mark, { x, y, width });
    });
  return marks.map((mark) => ({ ...mark, pill: placed.get(mark) ?? null }));
}
