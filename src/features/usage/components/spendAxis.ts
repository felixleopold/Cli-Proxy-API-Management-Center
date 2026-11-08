import { axisMax } from '@/features/dashboard/utils';
import { TALL_FACTOR } from '@/features/quota/tallCharts';

/** Gridline intervals of the spend chart at its normal height. */
const TICK_COUNT = 4;

/**
 * The spend chart's dollar scale and gridlines (fractions of the scale). The
 * scale never depends on the height: an expanded chart keeps the same maximum
 * and only subdivides it, so bars really grow with the extra room.
 */
export function spendAxis(peak: number, tall: boolean): { scaleMax: number; ticks: number[] } {
  const intervals = tall ? TICK_COUNT * TALL_FACTOR : TICK_COUNT;
  return {
    scaleMax: axisMax(peak, TICK_COUNT),
    ticks: Array.from({ length: intervals + 1 }, (_, index) => index / intervals),
  };
}
