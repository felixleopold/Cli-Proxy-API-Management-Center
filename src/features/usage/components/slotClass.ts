import type { UserSlot } from '../usageModel';
import styles from './userSlots.module.scss';

/** Class that sets `--series` to the user's categorical color. */
export const slotClassName = (slot: UserSlot): string =>
  slot === 'other'
    ? styles.slotOther
    : slot === 'unassigned'
      ? styles.slotUnassigned
      : styles[`slot${slot}`];
