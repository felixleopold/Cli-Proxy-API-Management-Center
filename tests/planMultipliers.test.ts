import { describe, expect, test } from 'bun:test';
import type { AuthFileItem } from '../src/types';
import {
  formatMultiplier,
  multiplierTotals,
  planShareOf,
  remainingMultiplier,
} from '../src/features/quota/planMultipliers';
import {
  DAY_MS,
  HOUR_MS,
  buildPools,
  providerMultipliers,
  projectPool,
  summarizePool,
  valueAt,
} from '../src/features/quota/quotaForecastModel';
import { normalizeAuthFilesResponse } from '../src/services/api/authFiles';
import {
  buildAuthFileFieldsPatch,
  type PrefixProxyEditorState,
} from '../src/features/authFiles/hooks/useAuthFilesPrefixProxyEditor';

const NOW = Date.UTC(2026, 9, 30, 12);
const unix = (ms: number) => String(ms / 1000);

/** A Codex credential with a weekly and a 5-hour window. */
const codex = (
  id: string,
  weekUsed: number,
  fiveUsed: number,
  extra: Partial<AuthFileItem> = {}
): AuthFileItem => ({
  name: `${id}.json`,
  id,
  provider: 'codex',
  quota: {
    observed_at: new Date(NOW).toISOString(),
    signals: {
      'X-Codex-Primary-Window-Minutes': '300',
      'X-Codex-Primary-Used-Percent': String(fiveUsed),
      'X-Codex-Primary-Reset-At': unix(NOW + 2 * HOUR_MS),
      'X-Codex-Secondary-Window-Minutes': '10080',
      'X-Codex-Secondary-Used-Percent': String(weekUsed),
      'X-Codex-Secondary-Reset-At': unix(NOW + 3 * DAY_MS),
    },
  },
  ...extra,
});

describe('plan share', () => {
  test('E = m × c/100, with an unset multiplier counted as 1 and no cap as 100', () => {
    expect(planShareOf({ planMultiplier: 10 })).toEqual({
      multiplier: 10,
      multiplierSet: true,
      capPercent: 100,
      effective: 10,
    });
    expect(planShareOf({ planMultiplier: 1, usageCapPercent: 75 }).effective).toBe(0.75);
    expect(planShareOf({})).toEqual({
      multiplier: 1,
      multiplierSet: false,
      capPercent: 100,
      effective: 1,
    });
  });

  test('what is left to us stops at the cap: R = m × max(0, c − u)/100', () => {
    const share = planShareOf({ planMultiplier: 2, usageCapPercent: 75 });
    expect(remainingMultiplier(share, 25)).toBe(1);
    expect(remainingMultiplier(share, 75)).toBe(0);
    // Usage past the cap (the gateway stops at it, a reading may overshoot) is not negative.
    expect(remainingMultiplier(share, 90)).toBe(0);
  });

  test('the API layer keeps a positive multiplier and a cap strictly inside (0, 100)', () => {
    const { files } = normalizeAuthFilesResponse({
      files: [
        { name: 'a.json', plan_multiplier: 10, usage_cap_percent: 75 },
        { name: 'b.json', plan_multiplier: '0.5', usage_cap_percent: 100 },
        { name: 'c.json', plan_multiplier: 0, usage_cap_percent: 'x' },
      ],
    });
    expect(files.map((file) => [file.planMultiplier, file.usageCapPercent])).toEqual([
      [10, 75],
      [0.5, undefined],
      [undefined, undefined],
    ]);
  });
});

describe('provider totals', () => {
  test('live Claude: Max 10× uncapped plus Pro 1× capped at 75 is 11× plans, 10.75× ours', () => {
    const totals = multiplierTotals([
      { share: planShareOf({ planMultiplier: 10 }), usedPercent: 40 },
      { share: planShareOf({ planMultiplier: 1, usageCapPercent: 75 }), usedPercent: 30 },
    ]);
    expect(totals.plans).toBe(11);
    expect(totals.effective).toBe(10.75);
    // 10 × 0.6 + 1 × 0.45
    expect(totals.remaining).toBeCloseTo(6.45);
    expect(totals.readEffective).toBe(10.75);
  });

  test('a credential without a reading counts toward plans but not toward what is left', () => {
    const totals = multiplierTotals([
      { share: planShareOf({ planMultiplier: 1 }), usedPercent: 50 },
      { share: planShareOf({}), usedPercent: null },
    ]);
    expect(totals).toMatchObject({ plans: 2, effective: 2, unset: 1, unread: 1 });
    expect(totals.remaining).toBe(0.5);
    expect(totals.readEffective).toBe(1);
  });

  test('live Codex: four Plus 1× with caps 75 and 65 pool to 4× plans, 3.4× ours', () => {
    const files = [
      codex('isabella', 50, 30, { planMultiplier: 1, usageCapPercent: 75 }),
      codex('mrak4family', 60, 5, { planMultiplier: 1, usageCapPercent: 65 }),
      codex('felix', 70, 45, { planMultiplier: 1 }),
      codex('hanna', 20, 0, { planMultiplier: 1 }),
      codex('off', 0, 0, { planMultiplier: 1, disabled: true }),
    ];
    const pools = buildPools(files);
    const [pool] = pools;
    expect(pool.capacity).toBeCloseTo(3.4);

    const [{ provider, multipliers }] = providerMultipliers(files, pools, NOW);
    expect(provider).toBe('codex');
    const { totals, weekly, short } = multipliers;
    expect(totals.plans).toBe(4);
    expect(totals.effective).toBeCloseTo(3.4);
    // 0.25 + 0.05 + 0.3 + 0.8
    expect(totals.remaining).toBeCloseTo(1.4);
    expect(weekly).toBe(true);
    expect(short?.minutes).toBe(300);
    // 0.45 + 0.6 + 0.55 + 1
    expect(short?.remaining).toBeCloseTo(2.6);
    expect(short?.of).toBeCloseTo(3.4);

    const summary = summarizePool(pool, NOW);
    expect(summary.remaining).toBeCloseTo(1.4);
    expect(summary.capacity).toBeCloseTo(3.4);
  });

  test('accounts without any reading keep their plans and share, with nothing left to show', () => {
    const files = [
      codex('a', 0, 0, { planMultiplier: 10, quota: undefined }),
      codex('b', 0, 0, { planMultiplier: 1, usageCapPercent: 75, quota: undefined }),
    ];
    const pools = buildPools(files);
    expect(pools).toEqual([]);
    expect(providerMultipliers(files, pools, NOW)).toEqual([
      {
        provider: 'codex',
        multipliers: {
          totals: {
            plans: 11,
            effective: 10.75,
            unset: 0,
            remaining: 0,
            readEffective: 0,
            unread: 2,
          },
          weekly: false,
          short: null,
        },
      },
    ]);
  });

  test('a capped credential runs out at its cap and refills to its share, not to 100%', () => {
    const file = codex('isabella', 50, 0, { planMultiplier: 2, usageCapPercent: 75 });
    // Reset in 3 days; 50% used 4 days in is 12.5% a day, so the cap is 2 days away.
    const [pool] = buildPools([file]);
    const series = projectPool(pool, NOW, NOW + 5 * DAY_MS);
    expect(valueAt(series, NOW)).toBeCloseTo(0.5);
    expect(valueAt(series, NOW + 2 * DAY_MS)).toBeCloseTo(0);
    expect(valueAt(series, NOW + 3 * DAY_MS)).toBeCloseTo(1.5);
    expect(summarizePool(pool, NOW).nextReset?.restore).toBeCloseTo(1.5);
  });

  test('multipliers read with at most two decimals, small rates with two significant digits', () => {
    expect(formatMultiplier(3.4, 'en')).toBe('3.4×');
    expect(formatMultiplier(10.75, 'en')).toBe('10.75×');
    expect(formatMultiplier(11, 'en')).toBe('11×');
    expect(formatMultiplier(0.0125, 'en')).toBe('0.013×');
    expect(formatMultiplier(0, 'en')).toBe('0×');
  });
});

describe('plan multiplier field', () => {
  const editor = (json: Record<string, unknown>, planMultiplier: string, providerKey = 'claude') =>
    ({
      json,
      providerKey,
      prefix: '',
      proxyUrl: '',
      priority: '',
      weight: '',
      usageCapPercent: String(json.usage_cap_percent ?? ''),
      planMultiplier,
    }) as PrefixProxyEditorState;
  const resolveError = (key: string) => key;

  test('sets a decimal, keeps an unchanged value and clears with null', () => {
    expect(buildAuthFileFieldsPatch(editor({}, '0.75'), resolveError)).toEqual({
      plan_multiplier: 0.75,
    });
    expect(buildAuthFileFieldsPatch(editor({ plan_multiplier: 10 }, '10'), resolveError)).toEqual(
      {}
    );
    expect(buildAuthFileFieldsPatch(editor({ plan_multiplier: 10 }, ''), resolveError)).toEqual({
      plan_multiplier: null,
    });
  });

  test('rejects zero, over 100 and text; ignores providers without a usage cap', () => {
    for (const value of ['0', '100.5', '-1', 'ten']) {
      expect(() => buildAuthFileFieldsPatch(editor({}, value), resolveError)).toThrow(
        'auth_files.plan_multiplier_invalid'
      );
    }
    expect(buildAuthFileFieldsPatch(editor({}, '2', 'antigravity'), resolveError)).toEqual({});
  });
});
