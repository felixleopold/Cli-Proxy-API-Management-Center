/** The page the app opens on: `/`, the fallback and retired paths all land here. */
export const DEFAULT_ROUTE = '/usage-quota';

/** Paths that are aliases of the starting page. */
const DEFAULT_ROUTE_ALIASES = new Set(['/', '/usage', '/quota']);

/**
 * Trims a trailing slash and maps aliases of the starting page onto it, so route
 * ordering and transitions treat `/`, `/usage` and `/quota` as `/usage-quota`.
 */
export function normalizeRoutePath(pathname: string): string {
  const trimmed = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return DEFAULT_ROUTE_ALIASES.has(trimmed) ? DEFAULT_ROUTE : trimmed;
}

interface RedirectLocation {
  pathname?: string;
  search?: string;
  hash?: string;
}

/**
 * Where to go after login: the protected location that sent the user to the login
 * page, with its query and hash kept, or `/` (which redirects to the starting page).
 */
export function resolvePostLoginRedirect(state: unknown): string {
  if (!state || typeof state !== 'object') return '/';
  const from = (state as { from?: unknown }).from;
  if (!from || typeof from !== 'object') return '/';
  const { pathname, search, hash } = from as RedirectLocation;
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname === '/login') {
    return '/';
  }
  return `${pathname}${typeof search === 'string' ? search : ''}${
    typeof hash === 'string' ? hash : ''
  }`;
}
