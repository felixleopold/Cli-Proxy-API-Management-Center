import { useEffect, useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { axisMax } from '@/features/dashboard/utils';
import {
  addUnits,
  axisTicks,
  formatUsd,
  type BucketUnit,
  type SeriesSlot,
  type StackedBucket,
  type TimeSpan,
} from '../usageModel';
import { slotClassName } from './slotClass';
import styles from './UsageSpendChart.module.scss';

const TICK_COUNT = 4;

export interface ChartSeries {
  key: string;
  slot: SeriesSlot;
  label: string;
}

export interface ChartMarker {
  atMs: number;
  label: string;
  iconSrc: string | null;
}

interface UsageSpendChartProps {
  stacked: StackedBucket[];
  /** Bottom to top. */
  series: ChartSeries[];
  span: TimeSpan;
  unit: BucketUnit;
  nowMs: number;
  /** Tint the part of the span after now (an in-progress window). */
  showFuture: boolean;
  markers: ChartMarker[];
  summary: string;
}

const position = (ms: number, span: TimeSpan) =>
  ((ms - span.startMs) / (span.endMs - span.startMs)) * 100;

export function UsageSpendChart({
  stacked,
  series,
  span,
  unit,
  nowMs,
  showFuture,
  markers,
  summary,
}: UsageSpendChartProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const tooltipId = useId();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  // A hover-opened tooltip must also close on Escape when focus is elsewhere (WCAG 1.4.13).
  useEffect(() => {
    if (activeIndex === null) return;
    const dismiss = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setActiveIndex(null);
    };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [activeIndex]);

  const peak = Math.max(0, ...stacked.map((bucket) => bucket.total));
  const scaleMax = axisMax(peak, TICK_COUNT);
  const yTicks = Array.from({ length: TICK_COUNT + 1 }, (_, index) => index / TICK_COUNT);
  const xTicks = useMemo(() => axisTicks(span, unit), [span, unit]);
  // Keyboard focus starts on the bucket containing now.
  const lastPastIndex = stacked.reduce(
    (last, bucket, index) => (bucket.startMs <= nowMs ? index : last),
    0
  );

  // Six-hour ticks are midnights within about a week: weekday first, then the date.
  const formatTick = (ms: number) => {
    const date = new Date(ms);
    if (unit === 'hour')
      return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    if (unit === 'sixHours') {
      return `${date.toLocaleDateString(locale, { weekday: 'short' })} ${date.getDate()}`;
    }
    return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  };

  const formatBucket = (bucket: StackedBucket) => {
    const time: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
    const day: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
    const start = new Date(bucket.startMs);
    const end = new Date(bucket.endMs);
    if (unit === 'hour' || unit === 'sixHours') {
      return `${start.toLocaleDateString(locale, day)} · ${start.toLocaleTimeString(locale, time)}–${end.toLocaleTimeString(locale, time)}`;
    }
    if (unit === 'day') return start.toLocaleDateString(locale, day);
    const short: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
    return `${start.toLocaleDateString(locale, short)} – ${new Date(bucket.endMs - 1).toLocaleDateString(locale, short)}`;
  };

  const handlePointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ms =
      span.startMs + ((event.clientX - rect.left) / rect.width) * (span.endMs - span.startMs);
    const index = stacked.findIndex((bucket) => ms >= bucket.startMs && ms < bucket.endMs);
    setActiveIndex(index === -1 ? null : index);
  };

  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    // Escape dismisses the tooltip (WCAG 1.4.13) and keeps focus on the chart.
    if (event.key === 'Escape') {
      if (activeIndex !== null) event.preventDefault();
      setActiveIndex(null);
      return;
    }
    const last = stacked.length - 1;
    const current = activeIndex ?? lastPastIndex;
    const next =
      event.key === 'ArrowLeft'
        ? Math.max(0, current - 1)
        : event.key === 'ArrowRight'
          ? Math.min(last, current + 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    setActiveIndex(next);
  };

  const active = activeIndex === null ? null : stacked[activeIndex];
  const activeMarkers = active
    ? markers.filter((marker) => marker.atMs >= active.startMs && marker.atMs < active.endMs)
    : [];
  const activeCenter = active ? position((active.startMs + active.endMs) / 2, span) : 0;
  const nowPosition = position(nowMs, span);

  return (
    <figure className={styles.chart}>
      <figcaption className={styles.legend}>
        {series.map((item) => (
          <span key={item.key} className={styles.legendItem}>
            <span className={`${styles.swatch} ${slotClassName(item.slot)}`} aria-hidden="true" />
            {item.label}
          </span>
        ))}
        {markers.length > 0 && (
          <span className={styles.legendItem}>
            <span className={styles.markerSwatch} aria-hidden="true" />
            {t('usage.chart_reset_legend')}
          </span>
        )}
      </figcaption>

      <div className={styles.plot}>
        <div className={styles.yAxis} aria-hidden="true">
          {yTicks.map((ratio) => (
            <span key={ratio} className={styles.yTick} style={{ bottom: `${ratio * 100}%` }}>
              {formatUsd(scaleMax * ratio, locale, true)}
            </span>
          ))}
        </div>

        <div
          className={styles.canvas}
          role="group"
          tabIndex={0}
          aria-label={`${summary}. ${t('usage.chart_keyboard_hint')}`}
          aria-describedby={active ? tooltipId : undefined}
          onPointerMove={handlePointer}
          onPointerLeave={() => setActiveIndex(null)}
          onFocus={() => setActiveIndex((index) => index ?? lastPastIndex)}
          onBlur={() => setActiveIndex(null)}
          onKeyDown={handleKey}
        >
          {yTicks.map((ratio) => (
            <span
              key={ratio}
              className={ratio === 0 ? styles.baseline : styles.gridline}
              style={{ bottom: `${ratio * 100}%` }}
              aria-hidden="true"
            />
          ))}

          {showFuture && nowPosition > 0 && nowPosition < 100 && (
            <span className={styles.future} style={{ left: `${nowPosition}%` }} aria-hidden="true">
              <span className={styles.futureLabel}>{t('usage.chart_now')}</span>
            </span>
          )}

          {stacked.map((bucket, index) => {
            const visible = series.filter((item) => (bucket.values.get(item.key) ?? 0) > 0);
            return (
              <span
                key={bucket.startMs}
                className={`${styles.column} ${index === activeIndex ? styles.columnActive : ''}`}
                style={{
                  left: `${position(bucket.startMs, span)}%`,
                  width: `${position(bucket.endMs, span) - position(bucket.startMs, span)}%`,
                }}
                aria-hidden="true"
              >
                <span className={styles.stack}>
                  {visible.map((item, segmentIndex) => (
                    <span
                      key={item.key}
                      className={`${styles.segment} ${slotClassName(item.slot)} ${
                        segmentIndex === visible.length - 1 ? styles.segmentTop : ''
                      }`}
                      style={{
                        height: `${((bucket.values.get(item.key) ?? 0) / scaleMax) * 100}%`,
                      }}
                    />
                  ))}
                </span>
              </span>
            );
          })}

          {markers.map((marker) => (
            <span
              key={`${marker.label}-${marker.atMs}`}
              className={styles.marker}
              style={{ left: `${position(marker.atMs, span)}%` }}
              aria-hidden="true"
            >
              {marker.iconSrc && <img className={styles.markerIcon} src={marker.iconSrc} alt="" />}
            </span>
          ))}

          {peak === 0 && <span className={styles.empty}>{t('usage.selection_empty')}</span>}

          {active && (
            <div
              id={tooltipId}
              className={styles.tooltip}
              style={{
                left: `${activeCenter}%`,
                transform:
                  activeCenter < 18
                    ? 'translateX(-12%)'
                    : activeCenter > 78
                      ? 'translateX(-88%)'
                      : 'translateX(-50%)',
              }}
              role="status"
            >
              <span className={styles.tooltipTitle}>{formatBucket(active)}</span>
              {[...series]
                .reverse()
                .filter((item) => (active.values.get(item.key) ?? 0) > 0)
                .map((item) => (
                  <span key={item.key} className={styles.tooltipRow}>
                    <span
                      className={`${styles.swatch} ${slotClassName(item.slot)}`}
                      aria-hidden="true"
                    />
                    {item.label}
                    <b>{formatUsd(active.values.get(item.key) ?? 0, locale)}</b>
                  </span>
                ))}
              <span className={styles.tooltipTotal}>
                {t('usage.total')}
                <b>{formatUsd(active.total, locale)}</b>
              </span>
              {activeMarkers.map((marker) => (
                <span key={`${marker.label}-${marker.atMs}`} className={styles.tooltipNote}>
                  {t('usage.chart_reset_at', {
                    name: marker.label,
                    time: new Date(marker.atMs).toLocaleTimeString(locale, {
                      hour: '2-digit',
                      minute: '2-digit',
                    }),
                  })}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className={styles.xAxis} aria-hidden="true">
        {xTicks.map((ms) => {
          // Day and week labels sit under their column; time labels on their instant.
          const at = position(
            unit === 'day' || unit === 'week' ? (ms + addUnits(ms, unit, 1)) / 2 : ms,
            span
          );
          return (
            <span
              key={ms}
              className={styles.xTick}
              style={{
                left: `${at}%`,
                transform: `translateX(${at < 3 ? 0 : at > 97 ? -100 : -50}%)`,
              }}
            >
              {formatTick(ms)}
            </span>
          );
        })}
      </div>
    </figure>
  );
}
