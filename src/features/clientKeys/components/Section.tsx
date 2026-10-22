import { useId, type PropsWithChildren, type ReactNode } from 'react';
import styles from './Section.module.scss';

interface SectionProps {
  title: string;
  hint?: ReactNode;
  /** Controls on the right of the heading. */
  actions?: ReactNode;
}

/** A page section: hairline, heading with hint and actions, then content. */
export function Section({ title, hint, actions, children }: PropsWithChildren<SectionProps>) {
  const titleId = useId();
  return (
    <section className={styles.section} aria-labelledby={titleId}>
      <header className={styles.head}>
        <div className={styles.copy}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          {hint && <p className={styles.hint}>{hint}</p>}
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </header>
      {children}
    </section>
  );
}
