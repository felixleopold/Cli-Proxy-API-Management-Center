/**
 * Taller charts on Usage & quota: each chart kind can be drawn about twice as
 * tall so dense steps, chips and resets separate. The choice is remembered per
 * kind in localStorage; without storage every chart simply starts at its normal
 * height.
 */

export const TALL_CHART_KINDS = ['forecast', 'drain', 'spend'] as const;
export type TallChartKind = (typeof TALL_CHART_KINDS)[number];

/** How much taller an expanded chart's plot is. */
export const TALL_FACTOR = 2;

const STORAGE_KEY = 'usageQuota.tallCharts';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const storageOrNull = (): StorageLike | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

/** The kinds stored as tall; empty when nothing is stored or storage fails. */
export function readTallCharts(storage: StorageLike | null = storageOrNull()): Set<TallChartKind> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '[]');
    return new Set(
      Array.isArray(parsed) ? TALL_CHART_KINDS.filter((kind) => parsed.includes(kind)) : []
    );
  } catch {
    return new Set();
  }
}

/** Remembers one kind's height, keeping the others; a failed write is ignored. */
export function writeTallChart(
  kind: TallChartKind,
  tall: boolean,
  storage: StorageLike | null = storageOrNull()
): void {
  const kinds = readTallCharts(storage);
  if (tall) kinds.add(kind);
  else kinds.delete(kind);
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify([...kinds]));
  } catch {
    // Private mode or full storage: the choice lasts for this page only.
  }
}
