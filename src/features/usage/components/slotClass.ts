import type { SeriesSlot } from '../usageModel';
import styles from './seriesSlots.module.scss';

/** Class that sets `--series` to the slot's categorical color. */
export const slotClassName = (slot: SeriesSlot): string =>
  slot === 'other' ? styles.slotOther : slot === 'none' ? styles.slotNone : styles[`slot${slot}`];
