/**
 * SVG charts for the pooled quota forecast: remaining quota as one filled row
 * per provider on a shared time axis (solid history, dashed projection inside
 * its likely range) and drain-rate columns. Data comes in ready-made
 * from quotaForecastModel.ts; this file only maps it to pixels and handles hover.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DAY_MS,
  HOUR_MS,
  capacityVaries,
  creditsInView,
  creditsNear,
  nightBands,
  valueAt,
  resetEventAt,
  resetUseOf,
  seriesJumps,
  type PoolResetEvent,
  type ResetAccount,
  type ResetUse,
  type SeriesPoint,
} from '../quotaForecastModel';
import styles from './QuotaForecast.module.scss';

const PLOT_HEIGHT = 180;
const MARGIN = { top: 30, right: 8, bottom: 40, left: 48 };
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
    const weekday = new Intl.DateTimeFormat(language, { weekday: 'short' });
    const dayNumber = new Intl.DateTimeFormat(language, { day: 'numeric' });
    const hour = new Intl.DateTimeFormat(language, { hour: 'numeric' });
    const time = new Intl.DateTimeFormat(language, { hour: 'numeric', minute: '2-digit' });
    const full = new Intl.DateTimeFormat(language, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    /** Weekday over the day of the month, like a calendar column. */
    const dayTick = (ms: number) => [weekday.format(ms), dayNumber.format(ms)];
    return {
      tick: (ms: number) => (isMidnight(ms) ? dayTick(ms) : [hour.format(ms)]),
      dayTick,
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

const makeFrame = (width: number, fromMs: number, toMs: number, yMax: number): Frame => {
  const top = MARGIN.top;
  const plotHeight = PLOT_HEIGHT;
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
  yTicks,
  formatValue,
  xTicks,
  formatTick,
}: {
  frame: Frame;
  yTicks: number[];
  formatValue: (v: number) => string;
  xTicks: number[];
  /** One or two lines per tick, e.g. ["Thu", "22"]. */
  formatTick: (ms: number) => string[];
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
      {xTicks.map((tick, index) => {
        const [main, sub] = formatTick(tick);
        const x = frame.x(tick);
        return (
          <text
            key={tick}
            className={styles.xTick}
            x={x}
            y={frame.baseY + 17}
            textAnchor={
              index === 0 && x - MARGIN.left < 16 ? 'start' : right - x < 16 ? 'end' : 'middle'
            }
          >
            {main}
            {sub && (
              <tspan className={styles.xTickSub} x={x} dy="1.3em">
                {sub}
              </tspan>
            )}
          </text>
        );
      })}
    </g>
  );
}

interface TooltipRow {
  key: string;
  color: string;
  dashed?: boolean;
  bar?: boolean;
  tick?: boolean;
  dot?: boolean;
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
              row.dot
                ? styles.keyDot
                : row.tick
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

/**
 * Keyboard: arrows move the crosshair a 48th of the view, stopping on any of
 * `stops` (e.g. resets) on the way so their details are reachable; Escape clears it.
 */
const useScrub = (fromMs: number, toMs: number, startAt: number, stops: readonly number[] = []) => {
  const [hoverMs, setHoverMs] = useState<number | null>(null);
  const step = (toMs - fromMs) / 48;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') setHoverMs(null);
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const direction = event.key === 'ArrowLeft' ? -1 : 1;
    setHoverMs((value) => {
      const from = value ?? startAt;
      const to = from + direction * step;
      const passed = stops.filter((stop) =>
        direction > 0 ? stop > from && stop < to : stop < from && stop > to
      );
      const next = passed.length > 0 ? passed[direction > 0 ? 0 : passed.length - 1] : to;
      return Math.min(toMs, Math.max(fromMs, next));
    });
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
  /** Pool size in plan multipliers; the y axis runs from 0 to this. */
  capacity: number;
  history: SeriesPoint[];
  projection: SeriesPoint[];
  /** Likely range around the projection (low at a busy pace, high at a quiet one), if shown. */
  range: { low: SeriesPoint[]; high: SeriesPoint[] } | null;
  /** Expiry instants of manual resets not yet used, drawn as markers. */
  credits: number[];
  /** Resets of the pool's accounts, recorded and projected, to colour and explain the jumps. */
  resets: PoolResetEvent[];
  /**
   * The pool's capacity over the history as a step function (capacity timeline);
   * null without one, when `capacity` holds throughout.
   */
  capacityHistory: SeriesPoint[] | null;
  /** Capacity changes in the history, labelled on the chart. */
  capacityMarks: CapacityMark[];
}

/** A capacity change: "Ultra retired" with "−10×", and the gateway's reason in the tooltip. */
export interface CapacityMark {
  atMs: number;
  label: string;
  delta: string;
  detail: string | null;
}

export interface RemainingChartProps {
  row: ForecastRow;
  /** Sleep hours of the day, shaded over the projection. */
  night: boolean[];
  fromMs: number;
  toMs: number;
  nowMs: number;
  formatValue: (v: number) => string;
  /** Tooltip and table value: a point and the pool's capacity, e.g. "1.45× · 43%". */
  formatPoint: (v: number, capacity: number) => string;
  /** A reset jump's label, e.g. "+0.89×". */
  formatJump: (delta: number) => string;
  ariaLabel: string;
  remainingLabel: string;
  projectedLabel: string;
  nowLabel: string;
  /** Tooltip name of a manual reset marker. */
  creditLabel: string;
  /** Name of a reset in the accessible table. */
  resetLabel: string;
  /** Tooltip row of one account in a reset, e.g. value "96% used", label "agent01". */
  formatResetAccount: (
    account: ResetAccount,
    projected: boolean
  ) => { value: string; label: string };
}

/** Hovering this close to a manual reset marker names it in the tooltip. */
const CREDIT_HOVER_PX = 6;
/** Jumps below this share of the pool are not labelled. */
const JUMP_LABEL_MIN_SHARE = 0.02;
/** Labels closer than this collide; the second moves below the line, else is dropped. */
const JUMP_LABEL_GAP_PX = 58;
/** Hovering this close to a reset names its accounts in the tooltip. */
const RESET_HOVER_PX = 10;
const JUMP_PILL_HEIGHT = 18;
/** Pill width from the label's length: tabular digits at 11px are about 6.5px wide. */
const pillWidth = (text: string) => Math.round(text.length * 6.5 + 12);

const USE_COLOR: Record<ResetUse, string> = {
  full: 'var(--success-color)',
  partial: 'var(--amber-color)',
  low: 'var(--danger-color)',
};

const areaPath = (points: { x: number; y: number }[], baseY: number) =>
  points.length > 1
    ? `${linePath(points)}L${points[points.length - 1].x},${baseY}L${points[0].x},${baseY}Z`
    : '';

/** The band between two lines: along the upper one, back along the lower one. */
const bandPath = (upper: { x: number; y: number }[], lower: { x: number; y: number }[]) =>
  upper.length > 1 && lower.length > 1
    ? `${linePath(upper)}${[...lower]
        .reverse()
        .map((point) => `L${point.x},${point.y}`)
        .join('')}Z`
    : '';

const seriesAt = (row: ForecastRow, t: number, nowMs: number) =>
  valueAt(t > nowMs ? row.projection : row.history, t);

/** The pool's capacity at t: the timeline's in the history, the current one ahead. */
const capacityAt = (row: ForecastRow, t: number, nowMs: number) =>
  (t <= nowMs && row.capacityHistory ? valueAt(row.capacityHistory, t) : null) ?? row.capacity;

/** Two instants this close are the same change (the gateway samples on a tick). */
const SAME_CHANGE_MS = 60 * 1000;

interface CapacityLabel {
  /** Marker line. */
  x: number;
  /** Pill centre. */
  cx: number;
  text: string;
}

/**
 * Capacity change pills along the top of the plot, centred on their marker line
 * where they fit; one that would overlap an earlier one is left to the tooltip.
 */
const placeCapacityLabels = (row: ForecastRow, frame: Frame): CapacityLabel[] => {
  const right = frame.width - MARGIN.right;
  const placed: { from: number; to: number }[] = [];
  return row.capacityMarks.flatMap((mark) => {
    const x = frame.x(mark.atMs);
    if (x < MARGIN.left || x > right) return [];
    const text = `${mark.label} ${mark.delta}`;
    const half = pillWidth(text) / 2;
    const cx = Math.min(right - half, Math.max(MARGIN.left + half, x));
    if (placed.some((spot) => cx + half + 4 > spot.from && cx - half - 4 < spot.to)) return [];
    placed.push({ from: cx - half, to: cx + half });
    return [{ x, cx, text }];
  });
};

interface JumpLabel {
  x: number;
  /** Centre line of the pill. */
  y: number;
  text: string;
  /** How fully the resetting accounts were used; null for a jump that is no reset (an account joining). */
  use: ResetUse | null;
}

/** Labels for reset jumps, kept apart: above the line, else below it, else dropped. */
const placeJumpLabels = (
  row: ForecastRow,
  frame: Frame,
  nowX: number,
  formatJump: (delta: number) => string,
  capacityLabels: CapacityLabel[]
): JumpLabel[] => {
  const minDelta = row.capacity * JUMP_LABEL_MIN_SHARE;
  // A capacity change explains its own step; it gets its marker, not a second pill.
  const jumps = [
    ...seriesJumps(row.history, minDelta),
    ...seriesJumps(row.projection, minDelta),
  ].filter(
    (jump) => !row.capacityMarks.some((mark) => Math.abs(mark.atMs - jump.t) <= SAME_CHANGE_MS)
  );
  const right = frame.width - MARGIN.right;
  // The "Now" label already sits above the plot, capacity pills along its top.
  const taken: { x: number; above: boolean }[] = [
    { x: nowX, above: true },
    ...capacityLabels.map((label) => ({ x: label.cx, above: true })),
  ];
  const clear = (x: number, above: boolean) =>
    taken.every((spot) => spot.above !== above || Math.abs(spot.x - x) >= JUMP_LABEL_GAP_PX);
  return jumps.flatMap((jump) => {
    const x = frame.x(jump.t);
    if (x < MARGIN.left || x > right) return [];
    const above = clear(x, true);
    if (!above && !clear(x, false)) return [];
    taken.push({ x, above });
    const text = formatJump(jump.to - jump.from);
    const half = pillWidth(text) / 2 + 2;
    const event = resetEventAt(row.resets, jump.t);
    return [
      {
        x: Math.min(right - half, Math.max(MARGIN.left + half, x)),
        y: above
          ? Math.max(frame.top + JUMP_PILL_HEIGHT / 2, frame.y(jump.to) - JUMP_PILL_HEIGHT / 2 - 4)
          : Math.min(
              frame.baseY - JUMP_PILL_HEIGHT / 2 - 2,
              frame.y(jump.from) + JUMP_PILL_HEIGHT / 2 + 4
            ),
        text,
        use: event ? resetUseOf(event.utilization) : null,
      },
    ];
  });
};

/** One pool's remaining quota: solid history, dashed projection inside its likely range. */
export function RemainingChart({
  row,
  night,
  fromMs,
  toMs,
  nowMs,
  formatValue,
  formatPoint,
  formatJump,
  ariaLabel,
  remainingLabel,
  projectedLabel,
  nowLabel,
  creditLabel,
  resetLabel,
  formatResetAccount,
}: RemainingChartProps) {
  const [ref, width] = useElementWidth();
  const gradientId = useId();
  const formats = useTimeFormats();
  const showCapacity = capacityVaries(row.capacityHistory, row.capacity);
  // The y axis reaches the largest capacity in view, so a retired plan's history still fits.
  const yMax = showCapacity
    ? Math.max(row.capacity, ...(row.capacityHistory ?? []).map((point) => point.v))
    : row.capacity;
  const frame = makeFrame(width, fromMs, toMs, yMax);
  const plotWidth = frame.plotWidth;
  const xTicks = useMemo(
    () => timeTicks(fromMs, toMs, Math.max(3, Math.floor(plotWidth / 64))),
    [fromMs, toMs, plotWidth]
  );
  const bands = useMemo(
    () => nightBands(night, Math.max(fromMs, nowMs), toMs),
    [night, fromMs, nowMs, toMs]
  );
  const resetStops = useMemo(
    () =>
      [
        ...row.resets.map((event) => event.atMs),
        ...row.capacityMarks.map((mark) => mark.atMs),
      ].sort((left, right) => left - right),
    [row.resets, row.capacityMarks]
  );
  const { hoverMs, setHoverMs, focusProps } = useScrub(fromMs, toMs, nowMs, resetStops);

  const onPointerMove = (event: PointerEvent<SVGRectElement>) => {
    const bounds = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (bounds) setHoverMs(frame.invertX(event.clientX - bounds.left));
  };

  const creditTolerance = (CREDIT_HOVER_PX / Math.max(1, plotWidth)) * (toMs - fromMs);
  const resetTolerance = (RESET_HOVER_PX / Math.max(1, plotWidth)) * (toMs - fromMs);
  const resetNear = (t: number) =>
    row.resets.reduce<PoolResetEvent | null>((best, event) => {
      const distance = Math.abs(event.atMs - t);
      return distance <= resetTolerance && (best === null || distance < Math.abs(best.atMs - t))
        ? event
        : best;
    }, null);
  const tooltipRows = (t: number): TooltipRow[] => {
    const value = seriesAt(row, t, nowMs);
    if (value === null) return [];
    const projected = t > nowMs;
    const low = projected && row.range ? valueAt(row.range.low, t) : null;
    const high = projected && row.range ? valueAt(row.range.high, t) : null;
    const name = projected ? projectedLabel : remainingLabel;
    return [
      {
        key: row.key,
        color: row.color,
        dashed: projected,
        value: formatPoint(value, capacityAt(row, t, nowMs)),
        label:
          low !== null && high !== null && formatValue(low) !== formatValue(high)
            ? `${name} · ${formatValue(low)}–${formatValue(high)}`
            : name,
      },
      ...(() => {
        const event = resetNear(t);
        if (!event) return [];
        const use = resetUseOf(event.utilization);
        return event.accounts.map((account) => ({
          key: `reset-${account.authId}`,
          color: USE_COLOR[use],
          dot: true,
          ...formatResetAccount(account, event.projected),
        }));
      })(),
      ...row.capacityMarks
        .filter((mark) => Math.abs(mark.atMs - t) <= resetTolerance)
        .map((mark, index) => ({
          key: `capacity-${index}`,
          color: 'var(--text-secondary)',
          tick: true,
          value: mark.delta,
          label: mark.detail ? `${mark.label} · ${mark.detail}` : mark.label,
        })),
      ...creditsNear(row.credits, t, creditTolerance, fromMs, toMs).map((expiresAtMs, index) => ({
        key: `credit-${index}`,
        color: 'var(--amber-color)',
        tick: true,
        value: formats.time(expiresAtMs),
        label: creditLabel,
      })),
    ];
  };

  const toPixels = (points: SeriesPoint[]) =>
    points.map((point) => ({ x: frame.x(point.t), y: frame.y(point.v) }));
  // Gaps (NaN points) split the history into separately drawn segments.
  const historySegments = row.history
    .reduce<SeriesPoint[][]>(
      (segments, point) => {
        if (Number.isNaN(point.v)) segments.push([]);
        else segments[segments.length - 1].push(point);
        return segments;
      },
      [[]]
    )
    .filter((segment) => segment.length > 0)
    .map(toPixels);
  const projection = toPixels(row.projection);
  const range = row.range ? bandPath(toPixels(row.range.high), toPixels(row.range.low)) : '';
  const current = row.projection[0];
  const hoverValue = hoverMs === null ? null : seriesAt(row, hoverMs, nowMs);
  const hoverRows = hoverMs === null ? [] : tooltipRows(hoverMs);
  const nowX = frame.x(nowMs);
  const capacityLabels = placeCapacityLabels(row, frame);
  const jumpLabels = placeJumpLabels(row, frame, nowX, formatJump, capacityLabels);
  // The capacity ceiling: the timeline's steps, then flat at today's capacity.
  const ceiling =
    showCapacity && row.capacityHistory
      ? linePath(
          toPixels([
            ...row.capacityHistory,
            {
              t: Math.max(nowMs, row.capacityHistory[row.capacityHistory.length - 1].t),
              v: row.capacity,
            },
            { t: toMs, v: row.capacity },
          ])
        )
      : '';

  return (
    <div ref={ref} className={styles.chart} {...focusProps} aria-label={ariaLabel} role="group">
      <svg
        width={width}
        height={HEIGHT}
        className={styles.svg}
        aria-hidden="true"
        style={{ color: row.color }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity={0.26} />
            <stop offset="100%" stopColor="currentColor" stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id={`${gradientId}-p`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity={0.12} />
            <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
          </linearGradient>
        </defs>

        <Axes
          frame={frame}
          yTicks={[0, yMax / 2, yMax]}
          formatValue={formatValue}
          xTicks={xTicks}
          formatTick={formats.tick}
        />

        {bands.map((band) => (
          <rect
            key={band.startMs}
            className={styles.nightBand}
            x={frame.x(band.startMs)}
            y={frame.top}
            width={frame.x(band.endMs) - frame.x(band.startMs)}
            height={PLOT_HEIGHT}
          />
        ))}

        {/* Under the data, so a reset that lands at now reads as a step in the fill. */}
        <line className={styles.nowLine} x1={nowX} x2={nowX} y1={frame.top - 8} y2={frame.baseY} />
        <text
          className={styles.nowLabel}
          x={nowX}
          y={frame.top - 13}
          textAnchor={nowX - MARGIN.left < 24 ? 'start' : 'middle'}
        >
          {nowLabel}
        </text>

        {creditsInView(row.credits, fromMs, toMs).map((expiresAtMs, index) => (
          <line
            key={`${expiresAtMs}-${index}`}
            className={styles.creditMarker}
            x1={frame.x(expiresAtMs)}
            x2={frame.x(expiresAtMs)}
            y1={frame.top + 1}
            y2={frame.baseY - 1}
          />
        ))}

        {capacityLabels.map((label) => (
          <line
            key={`capacity-${label.x}`}
            className={styles.capacityMarker}
            x1={label.x}
            x2={label.x}
            y1={frame.top + JUMP_PILL_HEIGHT + 2}
            y2={frame.baseY}
          />
        ))}
        {ceiling && <path className={styles.capacityLine} d={ceiling} stroke="currentColor" />}

        {historySegments.map((segment) => (
          <path
            key={`area-${segment[0].x}`}
            d={areaPath(segment, frame.baseY)}
            fill={`url(#${gradientId})`}
          />
        ))}
        <path d={areaPath(projection, frame.baseY)} fill={`url(#${gradientId}-p)`} />
        {range && <path className={styles.rangeBand} d={range} />}
        {historySegments.map(
          (segment) =>
            segment.length > 1 && (
              <path
                key={`line-${segment[0].x}`}
                className={styles.line}
                d={linePath(segment)}
                stroke="currentColor"
              />
            )
        )}
        {projection.length > 1 && (
          <path
            className={`${styles.line} ${styles.projected}`}
            d={linePath(projection)}
            stroke="currentColor"
          />
        )}

        {jumpLabels.map((label) => {
          const width = pillWidth(label.text);
          return (
            <g
              key={`${label.x}-${label.y}`}
              className={styles.jump}
              style={
                {
                  '--use': label.use ? USE_COLOR[label.use] : 'var(--text-secondary)',
                } as CSSProperties
              }
            >
              <rect
                className={styles.jumpPill}
                x={label.x - width / 2}
                y={label.y - JUMP_PILL_HEIGHT / 2}
                width={width}
                height={JUMP_PILL_HEIGHT}
                rx={JUMP_PILL_HEIGHT / 2}
              />
              <text className={styles.jumpLabel} x={label.x} y={label.y} dy="0.35em">
                {label.text}
              </text>
            </g>
          );
        })}

        {capacityLabels.map((label) => {
          const width = pillWidth(label.text);
          return (
            <g
              key={`capacity-pill-${label.x}`}
              className={styles.jump}
              style={{ '--use': 'var(--text-secondary)' } as CSSProperties}
            >
              <rect
                className={styles.jumpPill}
                x={label.cx - width / 2}
                y={frame.top + 1}
                width={width}
                height={JUMP_PILL_HEIGHT}
                rx={JUMP_PILL_HEIGHT / 2}
              />
              <text
                className={`${styles.jumpLabel} ${styles.capacityLabel}`}
                x={label.cx}
                y={frame.top + 1 + JUMP_PILL_HEIGHT / 2}
                dy="0.35em"
              >
                {label.text}
              </text>
            </g>
          );
        })}

        {current && (
          <circle className={styles.dot} cx={frame.x(current.t)} cy={frame.y(current.v)} r={4} />
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
          <circle className={styles.dot} cx={frame.x(hoverMs)} cy={frame.y(hoverValue)} r={4} />
        )}

        <rect
          className={styles.hitArea}
          x={MARGIN.left}
          y={frame.top}
          width={plotWidth}
          height={PLOT_HEIGHT}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHoverMs(null)}
        />
      </svg>

      {hoverMs !== null && hoverRows.length > 0 && (
        <Tooltip
          x={frame.x(hoverMs)}
          width={width}
          title={formats.full(hoverMs)}
          rows={hoverRows}
        />
      )}

      <SrTable
        caption={ariaLabel}
        head={['', row.label]}
        rows={[
          ...xTicks.map((tick) => ({
            t: tick,
            cells: (() => {
              const value = seriesAt(row, tick, nowMs);
              return [
                formats.full(tick),
                value === null ? '–' : formatPoint(value, capacityAt(row, tick, nowMs)),
              ];
            })(),
          })),
          // Each reset with its accounts and how much they had used.
          ...row.resets
            .filter((event) => event.atMs >= fromMs && event.atMs <= toMs)
            .map((event) => ({
              t: event.atMs,
              cells: [
                `${formats.full(event.atMs)} · ${resetLabel}`,
                event.accounts
                  .map((account) => {
                    const { label, value } = formatResetAccount(account, event.projected);
                    return `${label} ${value}`;
                  })
                  .join(', '),
              ],
            })),
          ...row.capacityMarks.map((mark) => ({
            t: mark.atMs,
            cells: [
              formats.full(mark.atMs),
              [`${mark.label} ${mark.delta}`, mark.detail].filter(Boolean).join(' · '),
            ],
          })),
        ]
          .sort((left, right) => left.t - right.t)
          .map((entry) => entry.cells)}
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
        : timeTicks(fromMs, toMs, Math.max(3, Math.floor(frame.plotWidth / 64))),
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
          formatTick={daily ? formats.dayTick : formats.tick}
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
