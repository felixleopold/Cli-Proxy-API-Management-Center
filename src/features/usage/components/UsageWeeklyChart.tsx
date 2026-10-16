import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { axisMax } from '@/features/dashboard/utils';
import { formatUsd, type UserSlot, type WindowRollup } from '../usageModel';
import { slotClassName } from './slotClass';
import styles from './UsageWeeklyChart.module.scss';

const TICK_COUNT = 4;

interface Series {
  key: string;
  slot: UserSlot;
  label: string;
}

interface UsageWeeklyChartProps {
  rollups: WindowRollup[];
  slots: Map<string, UserSlot>;
  selectedIndex: number;
  onSelect: (index: number) => void;
  /** Previous window's spend at the current window's elapsed point. */
  paceCostUsd: number | null;
  userLabel: (user: string) => string;
  formatWindow: (startMs: number, endMs: number) => string;
  formatDay: (ms: number) => string;
}

const slotOrder = (slot: UserSlot) => (slot === 'other' ? 100 : slot === 'unassigned' ? 101 : slot);

/** Spend per series in one window: named slots individually, the rest folded into "other". */
function seriesCosts(rollup: WindowRollup, slots: Map<string, UserSlot>) {
  const costs = new Map<string, number>();
  for (const user of rollup.users) {
    const slot = slots.get(user.user) ?? 'other';
    const key = slot === 'other' ? '\u0000other' : user.user;
    costs.set(key, (costs.get(key) ?? 0) + user.costUsd);
  }
  return costs;
}

export function UsageWeeklyChart({
  rollups,
  slots,
  selectedIndex,
  onSelect,
  paceCostUsd,
  userLabel,
  formatWindow,
  formatDay,
}: UsageWeeklyChartProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const costsByWindow = useMemo(
    () => rollups.map((rollup) => seriesCosts(rollup, slots)),
    [rollups, slots]
  );

  // Legend and stacking order follow the color slot, so each user keeps its place.
  const series = useMemo<Series[]>(() => {
    const keys = new Set(costsByWindow.flatMap((costs) => Array.from(costs.keys())));
    return Array.from(keys)
      .map((key): Series => {
        if (key === '\u0000other') {
          return { key, slot: 'other', label: t('usage.other_users') };
        }
        return { key, slot: slots.get(key) ?? 'other', label: userLabel(key) };
      })
      .sort((a, b) => slotOrder(a.slot) - slotOrder(b.slot));
  }, [costsByWindow, slots, t, userLabel]);

  const peak = Math.max(0, paceCostUsd ?? 0, ...rollups.map((rollup) => rollup.costUsd));
  const scaleMax = axisMax(peak, TICK_COUNT);
  const ticks = Array.from({ length: TICK_COUNT + 1 }, (_, index) => {
    const ratio = 1 - index / TICK_COUNT;
    return { ratio, value: scaleMax * ratio };
  });

  const active = activeIndex === null ? null : rollups[activeIndex];
  const activeCosts = activeIndex === null ? null : costsByWindow[activeIndex];
  const summary = t('usage.chart_summary', {
    windows: rollups.length,
    total: formatUsd(
      rollups.reduce((sum, rollup) => sum + rollup.costUsd, 0),
      locale
    ),
  });

  return (
    <figure className={styles.chart}>
      <figcaption className={styles.legend}>
        {series.map((item) => (
          <span key={item.key} className={styles.legendItem}>
            <span className={`${styles.swatch} ${slotClassName(item.slot)}`} aria-hidden="true" />
            {item.label}
          </span>
        ))}
        {paceCostUsd !== null && (
          <span className={styles.legendItem}>
            <span className={styles.paceSwatch} aria-hidden="true" />
            {t('usage.pace_legend')}
          </span>
        )}
      </figcaption>

      <div className={styles.plot}>
        <div className={styles.yAxis} aria-hidden="true">
          {ticks.map((tick) => (
            <span
              key={tick.ratio}
              className={styles.yTick}
              style={{ top: `${(1 - tick.ratio) * 100}%` }}
            >
              {formatUsd(tick.value, locale, true)}
            </span>
          ))}
        </div>

        <div className={styles.canvas}>
          <div className={styles.gridlines} aria-hidden="true">
            {ticks.map((tick) => (
              <span
                key={tick.ratio}
                className={styles.gridline}
                style={{ top: `${(1 - tick.ratio) * 100}%` }}
              />
            ))}
          </div>

          <div
            className={styles.columns}
            role="img"
            aria-label={summary}
            onMouseLeave={() => setActiveIndex(null)}
          >
            {rollups.map((rollup, index) => {
              const costs = costsByWindow[index];
              const visible = series.filter((item) => (costs.get(item.key) ?? 0) > 0);
              return (
                <button
                  type="button"
                  key={rollup.window.startMs}
                  className={`${styles.column} ${index === selectedIndex ? styles.columnSelected : ''}`}
                  aria-pressed={index === selectedIndex}
                  aria-label={`${formatWindow(rollup.window.startMs, rollup.window.endMs)}: ${formatUsd(rollup.costUsd, locale)}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onFocus={() => setActiveIndex(index)}
                  onBlur={() => setActiveIndex(null)}
                  onClick={() => onSelect(index)}
                >
                  <span className={styles.stack}>
                    {visible.map((item, segmentIndex) => (
                      <span
                        key={item.key}
                        className={`${styles.segment} ${slotClassName(item.slot)} ${
                          segmentIndex === visible.length - 1 ? styles.segmentTop : ''
                        }`}
                        style={{ height: `${((costs.get(item.key) ?? 0) / scaleMax) * 100}%` }}
                      />
                    ))}
                    {rollup.costUsd === 0 && <span className={styles.idleTick} />}
                    {rollup.window.current && paceCostUsd !== null && (
                      <span
                        className={styles.paceMark}
                        style={{ bottom: `${(paceCostUsd / scaleMax) * 100}%` }}
                        aria-hidden="true"
                      />
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          {active && activeCosts && (
            <div
              className={styles.tooltip}
              style={{
                left: `${((activeIndex! + 0.5) / rollups.length) * 100}%`,
                transform:
                  activeIndex! < rollups.length * 0.2
                    ? 'translateX(-15%)'
                    : activeIndex! >= rollups.length * 0.75
                      ? 'translateX(-85%)'
                      : 'translateX(-50%)',
              }}
              role="status"
            >
              <span className={styles.tooltipTitle}>
                {formatWindow(active.window.startMs, active.window.endMs)}
                {active.window.current && ` · ${t('usage.in_progress')}`}
              </span>
              {series
                .filter((item) => (activeCosts.get(item.key) ?? 0) > 0)
                .reverse()
                .map((item) => (
                  <span key={item.key} className={styles.tooltipRow}>
                    <span
                      className={`${styles.swatch} ${slotClassName(item.slot)}`}
                      aria-hidden="true"
                    />
                    {item.label}
                    <b>{formatUsd(activeCosts.get(item.key) ?? 0, locale)}</b>
                  </span>
                ))}
              <span className={styles.tooltipTotal}>
                {t('usage.total')}
                <b>{formatUsd(active.costUsd, locale)}</b>
              </span>
              {active.window.current && paceCostUsd !== null && (
                <span className={styles.tooltipPace}>
                  {t('usage.pace_legend')}
                  <b>{formatUsd(paceCostUsd, locale)}</b>
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className={styles.xAxis} aria-hidden="true">
        {rollups.map((rollup, index) => (
          <span
            key={rollup.window.startMs}
            className={`${styles.xTick} ${index === selectedIndex ? styles.xTickSelected : ''}`}
          >
            {rollup.window.current ? t('usage.in_progress') : formatDay(rollup.window.startMs)}
          </span>
        ))}
      </div>
    </figure>
  );
}
