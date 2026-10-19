/**
 * SVG charts for the pooled quota forecast: a remaining-quota line (solid
 * history, dashed projection) and drain-rate columns. Data comes in ready-made
 * from quotaForecastModel.ts; this file only maps it to pixels and handles hover.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { DAY_MS, HOUR_MS, nightBands, valueAt, type SeriesPoint } from '../quotaForecastModel';
import styles from './QuotaForecast.module.scss';

const PLOT_HEIGHT = 196;
const MARGIN = { top: 24, right: 14, bottom: 28, left: 52 };
const HEIGHT = PLOT_HEIGHT + MARGIN.top + MARGIN.bottom;
const FALLBACK_WIDTH = 760;
const TIME_STEPS = [3 * HOUR_MS, 6 * HOUR_MS, 12 * HOUR_MS, DAY_MS, 2 * DAY_MS, 7 * DAY_MS];

function useElementWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

const niceStep = (raw: number): number => {
  if (!(raw > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((step) => step >= raw) ?? raw;
};

/** Clean ticks from 0 to max; `max` itself is added when it is far enough from the last tick. */
function valueTicks(max: number, target = 4): number[] {
  const step = niceStep(max / target);
  const ticks: number[] = [];
  for (let value = 0; value <= max + 1e-9; value += step) ticks.push(value);
  const last = ticks[ticks.length - 1];
  if (max - last >= step / 2) ticks.push(max);
  return ticks;
}

/** Rounds max up to a clean tick so columns never touch the top. */
const niceCeiling = (max: number, target = 4): number => {
  const step = niceStep(max / target);
  return Math.max(step, Math.ceil(max / step) * step);
};

/** Ticks on local hour or midnight boundaries, at most `maxCount` of them. */
const timeTicks = (fromMs: number, toMs: number, maxCount: number): number[] => {
  const step =
    TIME_STEPS.find((candidate) => (toMs - fromMs) / candidate <= maxCount) ?? 7 * DAY_MS;
  const ticks: number[] = [];
  if (step >= DAY_MS) {
    const cursor = new Date(fromMs);
    cursor.setHours(0, 0, 0, 0);
    if (cursor.getTime() < fromMs) cursor.setDate(cursor.getDate() + 1);
    // Stepping by calendar days keeps ticks on midnight across DST changes.
    for (; cursor.getTime() <= toMs; cursor.setDate(cursor.getDate() + step / DAY_MS)) {
      ticks.push(cursor.getTime());
    }
    return ticks;
  }
  const cursor = new Date(fromMs);
  cursor.setMinutes(0, 0, 0);
  const hours = step / HOUR_MS;
  while (cursor.getTime() < fromMs || cursor.getHours() % hours !== 0) {
    cursor.setHours(cursor.getHours() + 1);
  }
  for (; cursor.getTime() <= toMs; cursor.setHours(cursor.getHours() + hours)) {
    ticks.push(cursor.getTime());
  }
  return ticks;
};

const isMidnight = (ms: number) => {
  const date = new Date(ms);
  return date.getHours() === 0 && date.getMinutes() === 0;
};

function useTimeFormats() {
  const { i18n } = useTranslation();
  const language = i18n.resolvedLanguage || i18n.language;
  return useMemo(() => {
    const day = new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric' });
    const hour = new Intl.DateTimeFormat(language, { hour: 'numeric' });
    const time = new Intl.DateTimeFormat(language, { hour: 'numeric', minute: '2-digit' });
    const full = new Intl.DateTimeFormat(language, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    return {
      tick: (ms: number) => (isMidnight(ms) ? day.format(ms) : hour.format(ms)),
      full: (ms: number) => full.format(ms),
      day: (ms: number) => day.format(ms),
      time: (ms: number) => time.format(ms),
    };
  }, [language]);
}

const linePath = (points: { x: number; y: number }[]) =>
  points.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join('');

interface Frame {
  width: number;
  plotWidth: number;
  x: (t: number) => number;
  y: (v: number) => number;
  invertX: (px: number) => number;
}

const makeFrame = (width: number, fromMs: number, toMs: number, yMax: number): Frame => {
  const plotWidth = width - MARGIN.left - MARGIN.right;
  const span = Math.max(1, toMs - fromMs);
  return {
    width,
    plotWidth,
    x: (t) => MARGIN.left + ((t - fromMs) / span) * plotWidth,
    y: (v) => MARGIN.top + PLOT_HEIGHT - (Math.min(v, yMax) / (yMax || 1)) * PLOT_HEIGHT,
    invertX: (px) =>
      fromMs + (Math.min(Math.max(px - MARGIN.left, 0), plotWidth) / plotWidth) * span,
  };
};

function Axes({
  frame,
  yTicks,
  formatValue,
  xTicks,
  formatTick,
}: {
  frame: Frame;
  yTicks: number[];
  formatValue: (v: number) => string;
  xTicks: number[];
  formatTick: (ms: number) => string;
}) {
  const right = frame.width - MARGIN.right;
  return (
    <g aria-hidden="true">
      {yTicks.map((tick) => (
        <g key={tick}>
          <line
            className={tick === 0 ? styles.baseline : styles.gridline}
            x1={MARGIN.left}
            x2={right}
            y1={frame.y(tick)}
            y2={frame.y(tick)}
          />
          <text className={styles.yTick} x={MARGIN.left - 8} y={frame.y(tick)} dy="0.32em">
            {formatValue(tick)}
          </text>
        </g>
      ))}
      {xTicks.map((tick, index) => (
        <text
          key={tick}
          className={styles.xTick}
          x={frame.x(tick)}
          y={HEIGHT - 8}
          textAnchor={
            index === 0 && frame.x(tick) - MARGIN.left < 24
              ? 'start'
              : right - frame.x(tick) < 24
                ? 'end'
                : 'middle'
          }
        >
          {formatTick(tick)}
        </text>
      ))}
    </g>
  );
}

interface TooltipRow {
  key: string;
  color: string;
  dashed?: boolean;
  bar?: boolean;
  value: string;
  label: string;
}

function Tooltip({
  x,
  width,
  title,
  rows,
}: {
  x: number;
  width: number;
  title: string;
  rows: TooltipRow[];
}) {
  // Sit beside the crosshair, never on it; flip to its left near the right edge.
  const flip = x > width * 0.62;
  return (
    <div
      className={styles.tooltip}
      style={{ left: x, top: MARGIN.top }}
      data-flip={flip ? 1 : 0}
      role="presentation"
    >
      <div className={styles.tooltipTitle}>{title}</div>
      {rows.map((row) => (
        <div key={row.key} className={styles.tooltipRow}>
          <span
            className={row.bar ? styles.keyBar : row.dashed ? styles.keyDashed : styles.keyLine}
            style={{ '--series': row.color } as CSSProperties}
          />
          <strong>{row.value}</strong>
          <span>{row.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Keyboard: arrows move the crosshair, Escape clears it. */
const useScrub = (fromMs: number, toMs: number, startAt: number) => {
  const [hoverMs, setHoverMs] = useState<number | null>(null);
  const step = (toMs - fromMs) / 48;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') setHoverMs(null);
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const direction = event.key === 'ArrowLeft' ? -1 : 1;
    setHoverMs((value) => Math.min(toMs, Math.max(fromMs, (value ?? startAt) + direction * step)));
  };
  return {
    hoverMs,
    setHoverMs,
    focusProps: {
      tabIndex: 0,
      onKeyDown,
      onFocus: () => setHoverMs((value) => value ?? startAt),
      onBlur: () => setHoverMs(null),
    },
  };
};

function SrTable({ caption, head, rows }: { caption: string; head: string[]; rows: string[][] }) {
  return (
    <table className={styles.srOnly}>
      <caption>{caption}</caption>
      <thead>
        <tr>
          {head.map((cell) => (
            <th key={cell} scope="col">
              {cell}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row[0]}>
            {row.map((cell, index) => (
              <td key={index}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ---------- Remaining quota ---------- */

export interface ForecastLine {
  key: string;
  label: string;
  /** A CSS color, e.g. var(--fc-claude). */
  color: string;
  history: SeriesPoint[];
  projection: SeriesPoint[];
}

export interface RemainingChartProps {
  lines: ForecastLine[];
  fromMs: number;
  toMs: number;
  nowMs: number;
  yMax: number;
  /** Area washes only read well under a single line. */
  fillArea: boolean;
  /** Quiet local hours of the day, shaded over the projection. */
  night: boolean[];
  formatValue: (v: number) => string;
  ariaLabel: string;
  /** Tooltip names for a lone line, which has no series name to show. */
  remainingLabel: string;
  projectedLabel: string;
  nowLabel: string;
}

export function RemainingChart({
  lines,
  fromMs,
  toMs,
  nowMs,
  yMax,
  fillArea,
  night,
  formatValue,
  ariaLabel,
  remainingLabel,
  projectedLabel,
  nowLabel,
}: RemainingChartProps) {
  const [ref, width] = useElementWidth();
  const gradientId = useId();
  const formats = useTimeFormats();
  const frame = makeFrame(width, fromMs, toMs, yMax);
  const yTicks = useMemo(() => valueTicks(yMax), [yMax]);
  const xTicks = useMemo(
    () => timeTicks(fromMs, toMs, Math.max(3, Math.floor(frame.plotWidth / 92))),
    [fromMs, toMs, frame.plotWidth]
  );
  const { hoverMs, setHoverMs, focusProps } = useScrub(fromMs, toMs, nowMs);
  const single = lines.length === 1;
  const bands = useMemo(
    () => nightBands(night, Math.max(fromMs, nowMs), toMs),
    [night, fromMs, nowMs, toMs]
  );

  const toPixels = (points: SeriesPoint[]) =>
    points.map((point) => ({ x: frame.x(point.t), y: frame.y(point.v) }));
  const baseY = frame.y(0);

  const onPointerMove = (event: PointerEvent<SVGRectElement>) => {
    const bounds = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (bounds) setHoverMs(frame.invertX(event.clientX - bounds.left));
  };

  const rowsAt = (t: number): TooltipRow[] =>
    lines.flatMap((line) => {
      const projected = t > nowMs;
      const value = valueAt(projected ? line.projection : line.history, t);
      if (value === null) return [];
      return [
        {
          key: line.key,
          color: line.color,
          dashed: projected,
          value: formatValue(value),
          label: single ? (projected ? projectedLabel : remainingLabel) : line.label,
        },
      ];
    });

  const tableRows = xTicks.map((tick) => [
    formats.full(tick),
    ...lines.map((line) => {
      const value = valueAt(tick > nowMs ? line.projection : line.history, tick);
      return value === null ? '–' : formatValue(value);
    }),
  ]);

  return (
    <div ref={ref} className={styles.chart} {...focusProps} aria-label={ariaLabel} role="group">
      <svg width={width} height={HEIGHT} className={styles.svg} aria-hidden="true">
        <Axes
          frame={frame}
          yTicks={yTicks}
          formatValue={formatValue}
          xTicks={xTicks}
          formatTick={formats.tick}
        />

        <g aria-hidden="true">
          {bands.map((band) => (
            <rect
              key={band.startMs}
              className={styles.nightBand}
              x={frame.x(band.startMs)}
              y={MARGIN.top}
              width={frame.x(band.endMs) - frame.x(band.startMs)}
              height={PLOT_HEIGHT}
            />
          ))}
        </g>

        {lines.map((line) => {
          const history = toPixels(line.history);
          const projection = toPixels(line.projection);
          const area = (points: { x: number; y: number }[]) =>
            points.length > 1
              ? `${linePath(points)}L${points[points.length - 1].x},${baseY}L${points[0].x},${baseY}Z`
              : '';
          return (
            <g key={line.key} style={{ color: line.color }}>
              {fillArea && (
                <>
                  <defs>
                    <linearGradient id={`${gradientId}-${line.key}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="currentColor" stopOpacity={0.2} />
                      <stop offset="100%" stopColor="currentColor" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id={`${gradientId}-${line.key}-p`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="currentColor" stopOpacity={0.09} />
                      <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <path d={area(history)} fill={`url(#${gradientId}-${line.key})`} />
                  <path d={area(projection)} fill={`url(#${gradientId}-${line.key}-p)`} />
                </>
              )}
              {history.length > 1 && (
                <path className={styles.line} d={linePath(history)} stroke="currentColor" />
              )}
              {projection.length > 1 && (
                <path
                  className={`${styles.line} ${styles.projected}`}
                  d={linePath(projection)}
                  stroke="currentColor"
                />
              )}
            </g>
          );
        })}

        <g aria-hidden="true">
          <line
            className={styles.nowLine}
            x1={frame.x(nowMs)}
            x2={frame.x(nowMs)}
            y1={MARGIN.top - 6}
            y2={baseY}
          />
          <text
            className={styles.nowLabel}
            x={frame.x(nowMs)}
            y={MARGIN.top - 11}
            textAnchor={frame.x(nowMs) - MARGIN.left < 24 ? 'start' : 'middle'}
          >
            {nowLabel}
          </text>
        </g>

        {lines.map((line) => {
          const current = line.projection[0];
          return current ? (
            <circle
              key={line.key}
              className={styles.dot}
              cx={frame.x(current.t)}
              cy={frame.y(current.v)}
              r={4}
              style={{ color: line.color }}
            />
          ) : null;
        })}

        {hoverMs !== null && (
          <g aria-hidden="true">
            <line
              className={styles.crosshair}
              x1={frame.x(hoverMs)}
              x2={frame.x(hoverMs)}
              y1={MARGIN.top}
              y2={baseY}
            />
            {lines.map((line) => {
              const value = valueAt(hoverMs > nowMs ? line.projection : line.history, hoverMs);
              return value === null ? null : (
                <circle
                  key={line.key}
                  className={styles.dot}
                  cx={frame.x(hoverMs)}
                  cy={frame.y(value)}
                  r={4}
                  style={{ color: line.color }}
                />
              );
            })}
          </g>
        )}

        <rect
          className={styles.hitArea}
          x={MARGIN.left}
          y={MARGIN.top}
          width={frame.plotWidth}
          height={PLOT_HEIGHT}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHoverMs(null)}
        />
      </svg>

      {hoverMs !== null && rowsAt(hoverMs).length > 0 && (
        <Tooltip
          x={frame.x(hoverMs)}
          width={width}
          title={formats.full(hoverMs)}
          rows={rowsAt(hoverMs)}
        />
      )}

      <SrTable
        caption={ariaLabel}
        head={['', ...lines.map((line) => line.label)]}
        rows={tableRows}
      />
    </div>
  );
}

/* ---------- Drain rate ---------- */

export interface DrainSeries {
  key: string;
  label: string;
  color: string;
  values: number[];
}

export interface DrainChartProps {
  series: DrainSeries[];
  /** Bucket boundaries; daily buckets follow calendar days, so widths can differ by DST. */
  edges: number[];
  /** The bucket still in progress; drawn quieter and labelled "so far". */
  partialIndex: number | null;
  /** Reference value per bucket; labelled by the panel legend. */
  pace: number | null;
  formatValue: (v: number) => string;
  ariaLabel: string;
  soFarLabel: string;
}

const columnPath = (x: number, width: number, top: number, base: number) => {
  const height = base - top;
  if (height <= 0) return '';
  // Rounded data end, square at the baseline.
  const r = Math.min(4, width / 2, height);
  return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + width - r}Q${x + width},${top} ${
    x + width
  },${top + r}V${base}Z`;
};

export function DrainChart({
  series,
  edges,
  partialIndex,
  pace,
  formatValue,
  ariaLabel,
  soFarLabel,
}: DrainChartProps) {
  const [ref, width] = useElementWidth();
  const formats = useTimeFormats();
  const count = Math.max(0, edges.length - 1);
  const fromMs = edges[0] ?? 0;
  const toMs = edges[count] ?? fromMs;
  const dataMax = Math.max(0, pace ?? 0, ...series.flatMap((entry) => entry.values));
  const yMax = niceCeiling(dataMax || 1);
  const frame = makeFrame(width, fromMs, toMs, yMax);
  const yTicks = useMemo(() => valueTicks(yMax), [yMax]);
  const daily = count > 0 && edges[1] - edges[0] > HOUR_MS;
  // Daily columns are categories: label each under its column, not on boundaries.
  const xTicks = useMemo(
    () =>
      daily
        ? edges.slice(0, -1).map((edge, index) => (edge + edges[index + 1]) / 2)
        : timeTicks(fromMs, toMs, Math.max(3, Math.floor(frame.plotWidth / 92))),
    [daily, edges, fromMs, toMs, frame.plotWidth]
  );
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  // Nominal band for sizing; positions follow the edges on the time axis.
  const band = frame.plotWidth / Math.max(1, count);
  const bandStart = (index: number) => frame.x(edges[index]);
  const bandCenter = (index: number) => (bandStart(index) + bandStart(index + 1)) / 2;
  const gap = 2;
  const columnWidth = Math.max(
    2,
    Math.min(24, (band * 0.72 - gap * (series.length - 1)) / Math.max(1, series.length))
  );
  const groupWidth = columnWidth * series.length + gap * (series.length - 1);
  const baseY = frame.y(0);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') setHoverIndex(null);
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const direction = event.key === 'ArrowLeft' ? -1 : 1;
    setHoverIndex((index) => Math.min(count - 1, Math.max(0, (index ?? count) + direction)));
  };

  const bucketTitle = (index: number) => {
    const start = edges[index];
    return daily
      ? formats.day(start)
      : `${formats.day(start)} ${formats.time(start)}–${formats.time(edges[index + 1])}`;
  };

  return (
    <div
      ref={ref}
      className={styles.chart}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onBlur={() => setHoverIndex(null)}
      aria-label={ariaLabel}
      role="group"
    >
      <svg width={width} height={HEIGHT} className={styles.svg} aria-hidden="true">
        <Axes
          frame={frame}
          yTicks={yTicks}
          formatValue={formatValue}
          xTicks={xTicks}
          formatTick={daily ? formats.day : formats.tick}
        />

        {Array.from({ length: count }, (_, index) => {
          const groupX = bandCenter(index) - groupWidth / 2;
          return (
            <g
              key={index}
              className={styles.columnGroup}
              data-partial={index === partialIndex ? 1 : 0}
              data-active={hoverIndex === index ? 1 : 0}
            >
              {series.map((entry, seriesIndex) => (
                <path
                  key={entry.key}
                  d={columnPath(
                    groupX + seriesIndex * (columnWidth + gap),
                    columnWidth,
                    frame.y(entry.values[index]),
                    baseY
                  )}
                  fill={entry.color}
                />
              ))}
              <rect
                className={styles.hitArea}
                x={bandStart(index)}
                y={MARGIN.top}
                width={bandStart(index + 1) - bandStart(index)}
                height={PLOT_HEIGHT}
                onPointerEnter={() => setHoverIndex(index)}
                onPointerLeave={() => setHoverIndex(null)}
              />
            </g>
          );
        })}

        {pace !== null && (
          <line
            className={styles.paceLine}
            aria-hidden="true"
            x1={MARGIN.left}
            x2={frame.width - MARGIN.right}
            y1={frame.y(pace)}
            y2={frame.y(pace)}
          />
        )}
      </svg>

      {hoverIndex !== null && (
        <Tooltip
          x={bandCenter(hoverIndex)}
          width={width}
          title={`${bucketTitle(hoverIndex)}${hoverIndex === partialIndex ? ` · ${soFarLabel}` : ''}`}
          rows={series.map((entry) => ({
            key: entry.key,
            color: entry.color,
            bar: true,
            value: formatValue(entry.values[hoverIndex]),
            label: entry.label,
          }))}
        />
      )}

      <SrTable
        caption={ariaLabel}
        head={['', ...series.map((entry) => entry.label)]}
        rows={Array.from({ length: count }, (_, index) => [
          bucketTitle(index),
          ...series.map((entry) => formatValue(entry.values[index])),
        ])}
      />
    </div>
  );
}
