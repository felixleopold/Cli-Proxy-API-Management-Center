/** The quiet icon button that makes a chart taller, or back to its normal height. */

import { useTranslation } from 'react-i18next';
import { IconFoldVertical, IconUnfoldVertical } from '@/components/ui/icons';
import styles from './TallChartToggle.module.scss';

export function TallChartToggle({ tall, onToggle }: { tall: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const label = t(tall ? 'quota_forecast.chart_shorter' : 'quota_forecast.chart_taller');
  return (
    <button
      type="button"
      className={styles.toggle}
      aria-pressed={tall}
      aria-label={label}
      title={label}
      onClick={onToggle}
    >
      {tall ? <IconFoldVertical size={14} /> : <IconUnfoldVertical size={14} />}
    </button>
  );
}
