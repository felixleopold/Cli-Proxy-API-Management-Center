import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { IconChevronDown, IconSlidersHorizontal } from '@/components/ui/icons';
import { OPTIONAL_COLUMNS, type ClientKeysViewPrefs } from '../viewPrefs';
import styles from './KeysList.module.scss';

interface ColumnsMenuProps {
  columns: ClientKeysViewPrefs['columns'];
  onChange: (columns: ClientKeysViewPrefs['columns']) => void;
}

/** Which optional columns the keys list shows; closes on Escape or a click outside. */
export function ColumnsMenu({ columns, onChange }: ColumnsMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={styles.menuRoot} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.menuButton}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <IconSlidersHorizontal size={14} />
        {t('client_keys.columns_button')}
        <IconChevronDown size={14} />
      </button>
      {open && (
        <div
          id={panelId}
          className={styles.menuPanel}
          role="group"
          aria-label={t('client_keys.columns_label')}
        >
          <p className={styles.menuTitle}>{t('client_keys.columns_label')}</p>
          {OPTIONAL_COLUMNS.map((column) => (
            <SelectionCheckbox
              key={column}
              checked={columns[column]}
              onChange={(checked) => onChange({ ...columns, [column]: checked })}
              label={t(`client_keys.col_${column}`)}
              ariaLabel={t(`client_keys.col_${column}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
