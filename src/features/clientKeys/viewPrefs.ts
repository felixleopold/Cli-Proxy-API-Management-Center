import type { Grouping } from './clientKeysModel';

/**
 * The keys list's view preferences, kept in localStorage across sessions: grouping and which
 * optional columns show. Name, status and actions always show; the project column shows in the
 * flat list only, since grouping already names the project.
 */

/** Optional columns in display order. Add a column here and render it in KeysList. */
export const OPTIONAL_COLUMNS = ['models', 'credentials', 'budget', 'expires', 'created'] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

export interface ClientKeysViewPrefs {
  grouping: Grouping;
  columns: Record<OptionalColumn, boolean>;
}

export const DEFAULT_VIEW_PREFS: ClientKeysViewPrefs = {
  grouping: 'project',
  columns: { models: true, credentials: true, budget: true, expires: false, created: false },
};

const STORAGE_KEY = 'clientKeysPage.viewPrefs';

/** Stored values over the defaults, so a column added later gets its default. */
export function parseViewPrefs(raw: string | null): ClientKeysViewPrefs {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return DEFAULT_VIEW_PREFS;
    const record = parsed as { grouping?: unknown; columns?: unknown };
    const stored =
      record.columns && typeof record.columns === 'object'
        ? (record.columns as Record<string, unknown>)
        : {};
    const columns = { ...DEFAULT_VIEW_PREFS.columns };
    for (const column of OPTIONAL_COLUMNS) {
      if (typeof stored[column] === 'boolean') columns[column] = stored[column];
    }
    return {
      grouping: record.grouping === 'flat' ? 'flat' : 'project',
      columns,
    };
  } catch {
    return DEFAULT_VIEW_PREFS;
  }
}

export function readViewPrefs(): ClientKeysViewPrefs {
  if (typeof window === 'undefined') return DEFAULT_VIEW_PREFS;
  try {
    return parseViewPrefs(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_VIEW_PREFS;
  }
}

export function writeViewPrefs(prefs: ClientKeysViewPrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or blocked: the preference lasts for this visit only.
  }
}

/**
 * The gateway URL in the reveal dialog's env snippet: where apps reach the gateway's model
 * port, which can differ from the panel's address (e.g. behind a management-only proxy).
 */
const GATEWAY_URL_KEY = 'clientKeysPage.gatewayUrl';

export function readGatewayUrl(): string | null {
  try {
    return window.localStorage.getItem(GATEWAY_URL_KEY);
  } catch {
    return null;
  }
}

/** An empty value forgets the stored URL, so the dialog falls back to the panel's address. */
export function writeGatewayUrl(url: string): void {
  try {
    if (url) window.localStorage.setItem(GATEWAY_URL_KEY, url);
    else window.localStorage.removeItem(GATEWAY_URL_KEY);
  } catch {
    // Storage full or blocked: the URL lasts for this dialog only.
  }
}
