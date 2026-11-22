/**
 * Keeps an absolutely positioned popover (a timed menu, the ⚙ settings, a chart
 * readout) visible horizontally: it opens beside its trigger as designed, and is
 * nudged sideways only when that would cut it off, at the screen edge or at an
 * ancestor that clips its overflow (the page's content column does), as a row's
 * pace buttons near the left edge of a phone would. Too wide to fit, it narrows.
 */

import { useLayoutEffect, type RefObject } from 'react';
import { clampShift } from '@/components/ui/HoverCard/clampShift';

/** Space kept between a popover and the screen edge, in px. */
export const VIEWPORT_GUTTER = 8;

const POPOVER_GAP = 6;
const MIN_SCROLL_HEIGHT = 160;

/**
 * The horizontal shift that moves a box spanning [left, left + width] inside
 * [min, max]; 0 when it already fits. A box wider than the range is pinned to
 * its start.
 */
export function shiftIntoBounds(left: number, width: number, min: number, max: number): number {
  return clampShift(left, left + width, max + VIEWPORT_GUTTER, min, max);
}

/** Picks above or below for a popover and caps its height when neither side fits the full box. */
export function verticalFit(
  anchorTop: number,
  anchorBottom: number,
  popoverHeight: number,
  viewportHeight: number,
  topEdge = VIEWPORT_GUTTER
): { placement: 'below' | 'above'; maxHeight: number | null } {
  const spaceBelow = viewportHeight - anchorBottom - VIEWPORT_GUTTER - POPOVER_GAP;
  const spaceAbove = anchorTop - topEdge - POPOVER_GAP;
  if (popoverHeight <= spaceBelow) return { placement: 'below', maxHeight: null };
  const placement = spaceAbove > spaceBelow ? 'above' : 'below';
  const available = Math.max(
    MIN_SCROLL_HEIGHT,
    Math.floor(placement === 'above' ? spaceAbove : spaceBelow)
  );
  return { placement, maxHeight: popoverHeight > available ? available : null };
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
 * Pass `vertical: true` for anchored menus/popovers that should flip above or scroll
 * within the viewport when opened near the bottom edge.
 */
export function useViewportClamp(
  ref: RefObject<HTMLElement | null>,
  key?: unknown,
  options?: { vertical?: boolean }
) {
  const vertical = options?.vertical ?? false;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const clamp = () => {
      element.style.translate = '';
      element.style.maxWidth = '';
      if (vertical) {
        element.style.top = '';
        element.style.bottom = '';
        element.style.maxHeight = '';
        element.style.overflowY = '';
      }
      const { min, max } = visibleRange(element);
      let rect = element.getBoundingClientRect();
      if (rect.width > max - min) {
        element.style.maxWidth = `${Math.floor(max - min)}px`;
        rect = element.getBoundingClientRect();
      }
      const shift = shiftIntoBounds(rect.left, rect.width, min, max);
      if (shift !== 0) element.style.translate = `${Math.round(shift)}px 0`;

      if (vertical && element.parentElement) {
        const anchorRect = element.parentElement.getBoundingClientRect();
        const vh = window.innerHeight || document.documentElement.clientHeight;
        const headerBottom = document.querySelector('.main-header')?.getBoundingClientRect().bottom;
        const topEdge =
          headerBottom && headerBottom > 0
            ? Math.max(VIEWPORT_GUTTER, Math.ceil(headerBottom) + VIEWPORT_GUTTER)
            : VIEWPORT_GUTTER;
        const fit = verticalFit(anchorRect.top, anchorRect.bottom, rect.height, vh, topEdge);
        if (fit.placement === 'above') {
          element.style.top = 'auto';
          element.style.bottom = `calc(100% + ${POPOVER_GAP}px)`;
        }
        if (fit.maxHeight !== null) {
          element.style.maxHeight = `${fit.maxHeight}px`;
          element.style.overflowY = 'auto';
        }
      }
    };
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, [ref, key, vertical]);
}
