/**
 * Keeps an absolutely positioned popover (a timed menu, the ⚙ settings, a chart
 * readout) visible horizontally: it opens beside its trigger as designed, and is
 * nudged sideways only when that would cut it off, at the screen edge or at an
 * ancestor that clips its overflow (the page's content column does), as a row's
 * pace buttons near the left edge of a phone would. Too wide to fit, it narrows.
 */

import { useLayoutEffect, type RefObject } from 'react';

/** Space kept between a popover and the screen edge, in px. */
export const VIEWPORT_GUTTER = 8;

/**
 * The horizontal shift that moves a box spanning [left, left + width] inside
 * [min, max]; 0 when it already fits. A box wider than the range is pinned to
 * its start.
 */
export function shiftIntoBounds(left: number, width: number, min: number, max: number): number {
  if (left < min || width > max - min) return min - left;
  if (left + width > max) return max - (left + width);
  return 0;
}

/** The horizontal range an element can show in: the viewport less its gutter, cut by clipping ancestors. */
function visibleRange(element: HTMLElement) {
  let min = VIEWPORT_GUTTER;
  let max = document.documentElement.clientWidth - VIEWPORT_GUTTER;
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflowX === 'visible') continue;
    const rect = node.getBoundingClientRect();
    min = Math.max(min, rect.left);
    max = Math.min(max, rect.right);
  }
  return { min, max };
}

/**
 * Applies shiftIntoBounds to the element as a CSS `translate` (and a max-width
 * when it is wider than the room), on mount, whenever `key` changes, and on resize.
 */
export function useViewportClamp(ref: RefObject<HTMLElement | null>, key?: unknown) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const clamp = () => {
      element.style.translate = '';
      element.style.maxWidth = '';
      const { min, max } = visibleRange(element);
      let rect = element.getBoundingClientRect();
      if (rect.width > max - min) {
        element.style.maxWidth = `${Math.floor(max - min)}px`;
        rect = element.getBoundingClientRect();
      }
      const shift = shiftIntoBounds(rect.left, rect.width, min, max);
      if (shift !== 0) element.style.translate = `${Math.round(shift)}px 0`;
    };
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, [ref, key]);
}
