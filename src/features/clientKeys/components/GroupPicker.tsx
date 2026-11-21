import { useTranslation } from 'react-i18next';
import styles from './GroupPicker.module.scss';

type GroupPickerProps = {
  /** Every group to offer, configured ones first. */
  choices: string[];
  /** Configured names; a choice outside them is marked as missing from config. */
  configured: string[];
  ariaLabel: string;
} & (
  | { mode: 'multi'; selected: string[]; onChange: (groups: string[]) => void }
  /** '' is the default pool. */
  | { mode: 'single'; selected: string; onChange: (group: string) => void }
);

/** Credential groups as one-click pills: several for an upstream key, one for a client key. */
export function GroupPicker(props: GroupPickerProps) {
  const { t } = useTranslation();
  const { choices, configured, ariaLabel } = props;
  const isOn = (group: string) =>
    props.mode === 'multi' ? props.selected.includes(group) : props.selected === group;
  const toggle = (group: string) => {
    if (props.mode === 'single') props.onChange(group);
    else
      props.onChange(
        isOn(group) ? props.selected.filter((g) => g !== group) : [...props.selected, group]
      );
  };
  const pill = (group: string, label: string) => {
    const missing = group !== '' && !configured.includes(group);
    return (
      <button
        key={group || '\u0000default'}
        type="button"
        className={[styles.pill, missing && styles.missing, group === '' && styles.plain]
          .filter(Boolean)
          .join(' ')}
        aria-pressed={isOn(group)}
        title={missing ? t('input_keys.group_missing') : undefined}
        onClick={() => toggle(group)}
      >
        {label}
      </button>
    );
  };

  return (
    <div className={styles.picker} role="group" aria-label={ariaLabel}>
      {props.mode === 'single' && pill('', t('client_keys.route_group_none'))}
      {choices.map((group) => pill(group, group))}
      {props.mode === 'multi' && props.selected.length > 0 && (
        <button type="button" className={styles.clear} onClick={() => props.onChange([])}>
          {t('input_keys.groups_clear')}
        </button>
      )}
    </div>
  );
}
