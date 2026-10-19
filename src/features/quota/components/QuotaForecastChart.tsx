/**
 * SVG charts for the pooled quota forecast: remaining quota as one filled row
 * per provider on a shared time axis (solid history, dashed projection) and
 * drain-rate columns. Data comes in ready-made
 * from quotaForecastModel.ts; this file only maps it to pixels and handles hover.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DAY_MS,
  HOUR_MS,
  creditsInView,
  creditsNear,
  nightBands,
  valueAt,
  type SeriesPoint,
} from '../quotaForecastModel';
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
  /** Plot area top and bottom (the zero line) in pixels. */
  top: number;
  baseY: number;
  x: (t: number) => number;
  y: (v: number) => number;
  invertX: (px: number) => number;
}

const makeFrame = (
  width: number,
  fromMs: number,
  toMs: number,
  yMax: number,
  top = MARGIN.top,
  plotHeight = PLOT_HEIGHT
): Frame => {
  const plotWidth = width - MARGIN.left - MARGIN.right;
  const span = Math.max(1, toMs - fromMs);
  return {
    width,
    plotWidth,
    top,
    baseY: top + plotHeight,
    x: (t) => MARGIN.left + ((t - fromMs) / span) * plotWidth,
    y: (v) => top + plotHeight - (Math.min(v, yMax) / (yMax || 1)) * plotHeight,
    invertX: (px) =>
      fromMs + (Math.min(Math.max(px - MARGIN.left, 0), plotWidth) / plotWidth) * span,
  };
};

function Axes({
  frame,
  height = HEIGHT,
  yTicks,
  formatValue,
  xTicks,
  formatTick,
}: {
  frame: Frame;
  /** Height of the SVG; x tick labels sit at its bottom. */
  height?: number;
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
          y={height - 8}
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
  tick?: boolean;
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
            className={
              row.tick
                ? styles.keyTick
                : row.bar
                  ? styles.keyBar
                  : row.dashed
                    ? styles.keyDashed
                    : styles.keyLine
            }
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
  // Hidden by a wrapper: a table caption is laid out outside the table box, so
  // Firefox does not clip it with the table itself.
  return (
    <div className={styles.srOnly}>
      <table>
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
    </div>
  );
}

/* ---------- Remaining quota ---------- */

export interface ForecastRow {
  key: string;
  label: string;
  /** A CSS color, e.g. var(--fc-claude). */
  color: string;
  /** Pool size in percent; the row's y axis runs from 0 to this. */
  capacity: number;
  history: SeriesPoint[];
  projection: SeriesPoint[];
  /** Quiet local hours of the day, shaded over the projection. */
  night: boolean[];
  /** Expiry instants of manual resets not yet used, drawn as markers. */
  credits: number[];
  /** Facts about the row, e.g. the next reset. */
  facts: string;
}

export interface RemainingChartProps {
  rows: ForecastRow[];
  fromMs: number;
  toMs: number;
  nowMs: number;
  formatValue: (v: number) => string;
  ariaLabel: string;
  /** Tooltip names for a lone row, which has no series name to show. */
  remainingLabel: string;
  projectedLabel: string;
  nowLabel: string;
  /** Tooltip name of a manual reset marker. */
  creditLabel: string;
}

/** Hovering this close to a manual reset marker names it in the tooltip. */
const CREDIT_HOVER_PX = 6;

/** Plot height of each row when providers are stacked. */
const ROW_PLOT_HEIGHT = 108;
const ROW_TOP = 10;
const ROW_BOTTOM = 8;

const fractionTicks = (max: number, parts: number) =>
  Array.from({ length: parts + 1 }, (_, index) => (max * index) / parts);

const areaPath = (points: { x: number; y: number }[], baseY: number) =>
  points.length > 1
    ? `${linePath(points)}L${points[points.length - 1].x},${baseY}L${points[0].x},${baseY}Z`
    : '';

const seriesAt = (row: ForecastRow, t: number, nowMs: number) =>
  valueAt(t > nowMs ? row.projection : row.history, t);

/**
 * Remaining quota, one row per provider in its own absolute pool percent, all
 * on one time axis with one "now". A lone provider gets a single taller row.
 */
export function RemainingChart({
  rows,
  fromMs,
  toMs,
  nowMs,
  formatValue,
  ariaLabel,
  remainingLabel,
  projectedLabel,
  nowLabel,
  creditLabel,
}: RemainingChartProps) {
  const [ref, width] = useElementWidth();
  const gradientId = useId();
  const formats = useTimeFormats();
  const single = rows.length === 1;
  const plotWidth = width - MARGIN.left - MARGIN.right;
  const xTicks = useMemo(
    () => timeTicks(fromMs, toMs, Math.max(3, Math.floor(plotWidth / 92))),
    [fromMs, toMs, plotWidth]
  );
  const bands = useMemo(
    () => rows.map((row) => nightBands(row.night, Math.max(fromMs, nowMs), toMs)),
    [rows, fromMs, nowMs, toMs]
  );
  const { hoverMs, setHoverMs, focusProps } = useScrub(fromMs, toMs, nowMs);

  const onPointerMove = (frame: Frame) => (event: PointerEvent<SVGRectElement>) => {
    const bounds = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (bounds) setHoverMs(frame.invertX(event.clientX - bounds.left));
  };

  const creditTolerance = (CREDIT_HOVER_PX / Math.max(1, plotWidth)) * (toMs - fromMs);
  const tooltipRows = (t: number): TooltipRow[] =>
    rows.flatMap((row) => {
      const value = seriesAt(row, t, nowMs);
      if (value === null) return [];
      const projected = t > nowMs;
      return [
        {
          key: row.key,
          color: row.color,
          dashed: projected,
          value: formatValue(value),
          label: single ? (projected ? projectedLabel : remainingLabel) : row.label,
        },
        ...creditsNear(row.credits, t, creditTolerance, fromMs, toMs).map((expiresAtMs, index) => ({
          key: `${row.key}-credit-${index}`,
          color: 'var(--amber-color)',
          tick: true,
          value: formats.time(expiresAtMs),
          label: creditLabel,
        })),
      ];
    });

  const tableRows = xTicks.map((tick) => [
    formats.full(tick),
    ...rows.map((row) => {
      const value = seriesAt(row, tick, nowMs);
      return value === null ? '–' : formatValue(value);
    }),
  ]);

  const hoverRows = hoverMs === null ? [] : tooltipRows(hoverMs);

  return (
    <div ref={ref} className={styles.chart} {...focusProps} aria-label={ariaLabel} role="group">
      {rows.map((row, index) => {
        const first = index === 0;
        const last = index === rows.length - 1;
        const top = first ? MARGIN.top : ROW_TOP;
        const plotHeight = single ? PLOT_HEIGHT : ROW_PLOT_HEIGHT;
        const height = top + plotHeight + (last ? MARGIN.bottom : ROW_BOTTOM);
        const frame = makeFrame(width, fromMs, toMs, row.capacity, top, plotHeight);
        const toPixels = (points: SeriesPoint[]) =>
          points.map((point) => ({ x: frame.x(point.t), y: frame.y(point.v) }));
        const history = toPixels(row.history);
        const projection = toPixels(row.projection);
        const current = row.projection[0];
        const hoverValue = hoverMs === null ? null : seriesAt(row, hoverMs, nowMs);
        const nowX = frame.x(nowMs);
        const fill = `${gradientId}-${row.key}`;
        const facts = <span className={styles.rowFacts}>{row.facts}</span>;
        return (
          <div key={row.key} className={styles.row}>
            {/* Stacked rows are named above their plot; a lone row keeps its facts below. */}
            {!single && (
              <div className={styles.rowHeader}>
                <span className={styles.rowName}>
                  <span
                    className={styles.poolDot}
                    style={{ '--series': row.color } as CSSProperties}
                    aria-hidden="true"
                  />
                  {row.label}
                </span>
                {facts}
              </div>
            )}
            <svg
              width={width}
              height={height}
              className={styles.svg}
              aria-hidden="true"
              style={{ color: row.color }}
            >
              <defs>
                <linearGradient id={fill} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity={0.24} />
                  <stop offset="100%" stopColor="currentColor" stopOpacity={0.04} />
                </linearGradient>
                <linearGradient id={`${fill}-p`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity={0.12} />
                  <stop offset="100%" stopColor="currentColor" stopOpacity={0.01} />
                </linearGradient>
              </defs>

              <Axes
                frame={frame}
                height={height}
                yTicks={fractionTicks(row.capacity, single ? 4 : 2)}
                formatValue={formatValue}
                xTicks={last ? xTicks : []}
                formatTick={formats.tick}
              />

              {bands[index].map((band) => (
                <rect
                  key={band.startMs}
                  className={styles.nightBand}
                  x={frame.x(band.startMs)}
                  y={frame.top}
                  width={frame.x(band.endMs) - frame.x(band.startMs)}
                  height={plotHeight}
                />
              ))}

              {/* Under the data, so a reset that lands at now reads as a step in the fill. */}
              <line
                className={styles.nowLine}
                x1={nowX}
                x2={nowX}
                y1={first ? frame.top - 6 : frame.top}
                y2={frame.baseY}
              />
              {first && (
                <text
                  className={styles.nowLabel}
                  x={nowX}
                  y={frame.top - 11}
                  textAnchor={nowX - MARGIN.left < 24 ? 'start' : 'middle'}
                >
                  {nowLabel}
                </text>
              )}

              {creditsInView(row.credits, fromMs, toMs).map((expiresAtMs, creditIndex) => (
                <line
                  key={`${expiresAtMs}-${creditIndex}`}
                  className={styles.creditMarker}
                  x1={frame.x(expiresAtMs)}
                  x2={frame.x(expiresAtMs)}
                  y1={frame.top + 1}
                  y2={frame.baseY - 1}
                />
              ))}

              <path d={areaPath(history, frame.baseY)} fill={`url(#${fill})`} />
              <path d={areaPath(projection, frame.baseY)} fill={`url(#${fill}-p)`} />
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
              {current && (
                <circle
                  className={styles.dot}
                  cx={frame.x(current.t)}
                  cy={frame.y(current.v)}
                  r={4}
                />
              )}

              {hoverMs !== null && (
                <line
                  className={styles.crosshair}
                  x1={frame.x(hoverMs)}
                  x2={frame.x(hoverMs)}
                  y1={frame.top}
                  y2={frame.baseY}
                />
              )}
              {hoverMs !== null && hoverValue !== null && (
                <circle
                  className={styles.dot}
                  cx={frame.x(hoverMs)}
                  cy={frame.y(hoverValue)}
                  r={4}
                />
              )}

              <rect
                className={styles.hitArea}
                x={MARGIN.left}
                y={frame.top}
                width={frame.plotWidth}
                height={plotHeight}
                onPointerMove={onPointerMove(frame)}
                onPointerLeave={() => setHoverMs(null)}
              />
            </svg>
            {single && row.facts && <div className={styles.rowFooter}>{facts}</div>}
          </div>
        );
      })}

      {hoverMs !== null && hoverRows.length > 0 && (
        <Tooltip
          x={MARGIN.left + ((hoverMs - fromMs) / Math.max(1, toMs - fromMs)) * plotWidth}
          width={width}
          title={formats.full(hoverMs)}
          rows={hoverRows}
        />
      )}

      <SrTable caption={ariaLabel} head={['', ...rows.map((row) => row.label)]} rows={tableRows} />
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
