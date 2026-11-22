/**
 * Clears a pinned chart readout when the page is pressed anywhere outside the
 * chart, so a readout tapped open on a touch screen never lingers.
 */

import { useEffect, type RefObject } from 'react';

export function useOutsideTap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  clear: () => void
) {
  useEffect(() => {
    if (!active) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) clear();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [ref, active, clear]);
}
