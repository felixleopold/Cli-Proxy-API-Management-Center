const VIEWPORT_MARGIN = 8;

/** Horizontal shift (px) that brings a card spanning [left, right] inside [minEdge, maxEdge]. */
export function clampShift(
  left: number,
  right: number,
  viewportWidth: number,
  minEdge = VIEWPORT_MARGIN,
  maxEdge = viewportWidth - VIEWPORT_MARGIN
): number {
  let shift = 0;
  if (right > maxEdge) shift = maxEdge - right;
  if (left + shift < minEdge) shift = minEdge - left;
  return shift;
}
