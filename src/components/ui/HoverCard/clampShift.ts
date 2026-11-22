const VIEWPORT_MARGIN = 8;

/** Horizontal shift (px) that brings a card spanning [left, right] inside the viewport. */
export function clampShift(left: number, right: number, viewportWidth: number): number {
  let shift = 0;
  if (right > viewportWidth - VIEWPORT_MARGIN) shift = viewportWidth - VIEWPORT_MARGIN - right;
  if (left + shift < VIEWPORT_MARGIN) shift = VIEWPORT_MARGIN - left;
  return shift;
}
