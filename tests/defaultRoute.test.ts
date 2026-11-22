import { describe, expect, test } from 'bun:test';
import { DEFAULT_ROUTE, normalizeRoutePath, resolvePostLoginRedirect } from '@/router/routePaths';

// The route table imports every page (and their CSS modules), so check its source.
const routesSource = await Bun.file('src/router/MainRoutes.tsx').text();
const layoutSource = await Bun.file('src/components/layout/MainLayout.tsx').text();
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Every element a path is mapped to (plugin paths have one per plugin-support branch). */
const routeElements = (path: string) =>
  [
    ...routesSource.matchAll(
      new RegExp(`\\{ path: '${escapeRegExp(path)}', element: (<.+/>) \\},$`, 'gm')
    ),
  ].map((match) => match[1]);
const routeElement = (path: string) => routeElements(path)[0];

describe('default route', () => {
  test('the root opens Usage & quota', () => {
    expect(DEFAULT_ROUTE).toBe('/usage-quota');
    expect(routeElement('/')).toBe('<Navigate to={DEFAULT_ROUTE} replace />');
    expect(routeElement('/usage-quota')).toBe('<UsageQuotaPage />');
  });

  test('the dashboard keeps its own page', () => {
    expect(routeElement('/dashboard')).toBe('<DashboardPage />');
  });

  test('retired, unknown and disabled plugin paths land on the starting page via /', () => {
    expect(routeElement('/usage')).toBe('<Navigate to="/usage-quota" replace />');
    expect(routeElement('/quota')).toBe('<Navigate to="/usage-quota" replace />');
    expect(routeElement('*')).toBe('<Navigate to="/" replace />');
    expect(routeElements('/plugin-store')).toContain('<Navigate to="/" replace />');
    expect(routeElements('/plugins/*')).toContain('<Navigate to="/" replace />');
  });

  test('Usage & quota is the first sidebar entry and the dashboard links to /dashboard', () => {
    const navSource = layoutSource.slice(layoutSource.indexOf('const navGroups'));
    const paths = [...navSource.matchAll(/^\s+path: '([^']+)',$/gm)].map((m) => m[1]);
    expect(paths[0]).toBe('/usage-quota');
    expect(paths[1]).toBe('/dashboard');
    expect(paths).not.toContain('/');
  });

  test('route aliases normalize to the starting page for ordering and transitions', () => {
    expect(normalizeRoutePath('/')).toBe('/usage-quota');
    expect(normalizeRoutePath('/usage')).toBe('/usage-quota');
    expect(normalizeRoutePath('/quota/')).toBe('/usage-quota');
    expect(normalizeRoutePath('/dashboard/')).toBe('/dashboard');
    expect(normalizeRoutePath('/auth-files/oauth-excluded')).toBe('/auth-files/oauth-excluded');
  });
});

describe('post-login redirect', () => {
  test('keeps the deep link with its query and hash', () => {
    expect(
      resolvePostLoginRedirect({
        from: { pathname: '/logs', search: '?level=error', hash: '#tail' },
      })
    ).toBe('/logs?level=error#tail');
  });

  test('falls back to / without a usable origin', () => {
    expect(resolvePostLoginRedirect(null)).toBe('/');
    expect(resolvePostLoginRedirect({})).toBe('/');
    expect(resolvePostLoginRedirect({ from: { pathname: 'https://evil.example' } })).toBe('/');
    expect(resolvePostLoginRedirect({ from: { pathname: '/login' } })).toBe('/');
  });
});
