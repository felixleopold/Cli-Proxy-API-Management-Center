/**
 * A small card that explains its trigger. It opens on hover and keyboard focus with
 * pointer devices, and on tap with touch screens (tap again, tap outside or press
 * Escape to close). The card is shifted horizontally to stay inside the viewport and
 * describes the trigger for assistive technology through aria-describedby.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { IconInfo } from '@/components/ui/icons';
import { clampShift } from './clampShift';
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

const INTERACTIVE_SELECTOR =
  'a[href], button, input, select, textarea, label, summary, [role="button"], [role="link"]';

const isTouchOnly = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(hover: none)').matches;

export function HoverCard({
  content,
  children,
  placement = 'below',
  align = 'start',
  focusable,
  className,
}: HoverCardProps) {
  const id = useId();
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const cardRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Measure after the card is shown, then shift it back inside the viewport and clipping ancestors.
  const clampToViewport = useCallback(() => {
    window.requestAnimationFrame(() => {
      const card = cardRef.current;
      if (!card) return;
      card.style.setProperty('--hover-card-shift', '0px');
      card.style.maxWidth = '';
      const vw = document.documentElement.clientWidth;
      let minEdge = 8;
      let maxEdge = vw - 8;
      for (let node = card.parentElement; node; node = node.parentElement) {
        if (getComputedStyle(node).overflowX === 'visible') continue;
        const ancestorRect = node.getBoundingClientRect();
        minEdge = Math.max(minEdge, ancestorRect.left);
        maxEdge = Math.min(maxEdge, ancestorRect.right);
      }
      let rect = card.getBoundingClientRect();
      if (rect.width === 0) return;
      if (maxEdge > minEdge && rect.width > maxEdge - minEdge) {
        card.style.maxWidth = `${Math.floor(maxEdge - minEdge)}px`;
        rect = card.getBoundingClientRect();
      }
      const shift = clampShift(rect.left, rect.right, vw, minEdge, maxEdge);
      card.style.setProperty('--hover-card-shift', `${Math.round(shift)}px`);
    });
  }, []);

  // A tapped-open card closes on a tap outside or Escape.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const handleClick = (event: ReactMouseEvent<HTMLSpanElement>) => {
    if (!isTouchOnly()) return;
    const target = event.target as Element;
    if (cardRef.current?.contains(target)) {
      event.stopPropagation();
      setOpen(false);
      return;
    }
    // Let buttons and links inside the trigger do their own job.
    const interactive = target.closest(INTERACTIVE_SELECTOR);
    if (interactive && event.currentTarget.contains(interactive)) return;
    event.stopPropagation();
    setDismissed(false);
    setOpen((prev) => {
      if (!prev) clampToViewport();
      return !prev;
    });
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== 'Escape') return;
    setOpen(false);
    setDismissed(true);
  };

  const reset = () => {
    if (dismissed) setDismissed(false);
  };

  return (
    <span
      ref={anchorRef}
      className={`${styles.anchor} ${className ?? ''}`}
      data-placement={placement}
      data-align={align}
      data-open={open ? 'true' : undefined}
      data-dismissed={dismissed ? 'true' : undefined}
      tabIndex={focusable ? 0 : undefined}
      aria-describedby={id}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') clampToViewport();
      }}
      onPointerLeave={reset}
      onFocus={clampToViewport}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) reset();
      }}
    >
      {children}
      <span ref={cardRef} id={id} role="tooltip" className={styles.card}>
        {content}
      </span>
    </span>
  );
}

/** An ⓘ that explains a label on hover, focus or tap. */
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
