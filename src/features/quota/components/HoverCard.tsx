/**
 * A small card that explains its trigger on hover and on keyboard focus, shown
 * by CSS alone (no timers, no animation). The card describes the trigger for
 * assistive technology through aria-describedby.
 */

import { useId, type ReactNode } from 'react';
import { IconInfo } from '@/components/ui/icons';
import styles from './HoverCard.module.scss';

export interface HoverCardProps {
  content: ReactNode;
  children: ReactNode;
  /** Where the card opens; below by default. */
  placement?: 'below' | 'above';
  /** Which edge of the trigger the card lines up with. */
  align?: 'start' | 'center' | 'end';
  /** Makes a non-interactive trigger focusable so the card opens from the keyboard too. */
  focusable?: boolean;
  className?: string;
}

export function HoverCard({
  content,
  children,
  placement = 'below',
  align = 'start',
  focusable,
  className,
}: HoverCardProps) {
  const id = useId();
  return (
    <span
      className={`${styles.anchor} ${className ?? ''}`}
      data-placement={placement}
      data-align={align}
      tabIndex={focusable ? 0 : undefined}
      aria-describedby={id}
    >
      {children}
      <span id={id} role="tooltip" className={styles.card}>
        {content}
      </span>
    </span>
  );
}

/** An ⓘ that explains a label on hover or focus. */
export function InfoHint({
  text,
  label,
  align = 'start',
  placement,
}: {
  text: ReactNode;
  /** Accessible name of the hint, e.g. the field it explains. */
  label: string;
  align?: HoverCardProps['align'];
  placement?: HoverCardProps['placement'];
}) {
  return (
    <HoverCard content={text} align={align} placement={placement} className={styles.info}>
      <span className={styles.infoIcon} role="img" tabIndex={0} aria-label={label}>
        <IconInfo size={12} aria-hidden="true" />
      </span>
    </HoverCard>
  );
}
