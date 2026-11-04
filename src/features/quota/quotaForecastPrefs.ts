/**
 * Pool card preferences that outlive the session (localStorage): which cards are
 * collapsed, the burn-rate window and the future-usage choice.
 */

import {
  BURN_WINDOW_HOURS,
  FORECAST_PROVIDERS,
  FUTURE_USAGE,
  type BurnWindowHours,
  type ForecastProvider,
  type FutureUsage,
} from './quotaForecastModel';

export interface ForecastPrefs {
  collapsed: Record<ForecastProvider, boolean>;
  burnHours: BurnWindowHours;
  future: FutureUsage;
}

const KEY = 'quotaPage.forecastPrefs';

/** Muse starts as a one-line summary; Claude and Codex open. */
export const DEFAULT_FORECAST_PREFS: ForecastPrefs = {
  collapsed: { claude: false, codex: false, meta: true },
  burnHours: 3,
  future: 'usual',
};

const includes = <T>(list: readonly T[], value: unknown): value is T =>
  (list as readonly unknown[]).includes(value);

/** Valid fields of a stored value over the defaults; anything else is ignored. */
export function parseForecastPrefs(raw: unknown): ForecastPrefs {
  const stored = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const collapsed =
    stored.collapsed && typeof stored.collapsed === 'object'
      ? (stored.collapsed as Record<string, unknown>)
      : {};
  return {
    collapsed: Object.fromEntries(
      FORECAST_PROVIDERS.map((provider) => {
        const value = collapsed[provider];
        return [
          provider,
          typeof value === 'boolean' ? value : DEFAULT_FORECAST_PREFS.collapsed[provider],
        ];
      })
    ) as Record<ForecastProvider, boolean>,
    burnHours: includes(BURN_WINDOW_HOURS, stored.burnHours)
      ? stored.burnHours
      : DEFAULT_FORECAST_PREFS.burnHours,
    future: includes(FUTURE_USAGE, stored.future) ? stored.future : DEFAULT_FORECAST_PREFS.future,
  };
}

export function readForecastPrefs(): ForecastPrefs {
  if (typeof window === 'undefined') return DEFAULT_FORECAST_PREFS;
  try {
    return parseForecastPrefs(JSON.parse(window.localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return DEFAULT_FORECAST_PREFS;
  }
}

export function writeForecastPrefs(prefs: ForecastPrefs) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or blocked: the choice just lasts until reload.
  }
}
