import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../src/i18n/index';
import { readTallCharts, writeTallChart } from '../src/features/quota/tallCharts';
import { DrainChart, RemainingChart } from '../src/features/quota/components/QuotaForecastChart';
import { TallChartToggle } from '../src/features/quota/components/TallChartToggle';
import { spendAxis } from '../src/features/usage/components/spendAxis';

const memory = () => {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
};

describe('taller charts', () => {
  test('remembers each chart kind on its own', () => {
    const storage = memory();
    writeTallChart('forecast', true, storage);
    writeTallChart('spend', true, storage);
    writeTallChart('spend', false, storage);
    expect([...readTallCharts(storage)]).toEqual(['forecast']);
  });

  test('works without storage, or with broken or foreign values', () => {
    expect(readTallCharts(null).size).toBe(0);
    const broken = { getItem: () => '{not json', setItem: () => undefined };
    expect(readTallCharts(broken).size).toBe(0);
    const foreign = { getItem: () => '["forecast","sideways"]', setItem: () => undefined };
    expect([...readTallCharts(foreign)]).toEqual(['forecast']);
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(() => writeTallChart('drain', true, full)).not.toThrow();
  });
});

describe('taller charts render', () => {
  const formatValue = (value: number) => `v${value}`;
  const remaining = (tall: boolean) =>
    renderToStaticMarkup(
      createElement(RemainingChart, {
        tall,
        row: {
          key: 'codex',
          label: 'Codex',
          color: 'gray',
          capacity: 4,
          history: [],
          projection: [
            { t: 0, v: 3 },
            { t: 10, v: 1 },
          ],
          range: null,
          credits: [],
          resets: [],
          capacityHistory: null,
          capacityMarks: [],
        },
        night: [],
        fromMs: 0,
        toMs: 10,
        nowMs: 0,
        formatValue,
        formatPoint: formatValue,
        formatJump: formatValue,
        ariaLabel: 'remaining',
        remainingLabel: 'Recorded',
        projectedLabel: 'Projected',
        nowLabel: 'Now',
        creditLabel: 'Credit',
        resetLabel: 'Reset',
        formatResetAccount: () => ({ value: '', label: '' }),
        formatChangeCount: (count: number) => `${count}`,
      })
    );
  const drain = (tall: boolean) =>
    renderToStaticMarkup(
      createElement(DrainChart, {
        tall,
        series: [{ key: 'codex', label: 'Codex', color: 'gray', values: [1, 3] }],
        edges: [0, 1, 2],
        partialIndex: null,
        pace: null,
        formatValue,
        ariaLabel: 'drain',
        soFarLabel: 'so far',
      })
    );
  const ticks = (markup: string) =>
    [...markup.matchAll(/>v([\d.]+)</g)].map((match) => Number(match[1]));

  test('an expanded chart is twice as tall with the same scale and more ticks', () => {
    for (const render of [remaining, drain]) {
      const [normal, tall] = [render(false), render(true)];
      // SVG: 30 top + 40 bottom margins around a 180 or 360px plot (also the hit area).
      expect(normal).toContain('height="250"');
      expect(tall).toContain('height="430"');
      expect(normal).toContain('height="180"');
      expect(tall).toContain('height="360"');
      expect(Math.max(...ticks(tall))).toBe(Math.max(...ticks(normal)));
      expect(ticks(tall).length).toBeGreaterThan(ticks(normal).length);
    }
  });

  test('the toggle keeps one name and reports its state as pressed', () => {
    const toggle = (tall: boolean) =>
      renderToStaticMarkup(createElement(TallChartToggle, { tall, onToggle: () => undefined }));
    expect(toggle(false)).toContain('aria-pressed="false"');
    expect(toggle(true)).toContain('aria-pressed="true"');
    const attribute = (markup: string, name: string) =>
      new RegExp(`${name}="([^"]*)"`).exec(markup)?.[1];
    // One accessible name in both states; only the tooltip says what a click does.
    expect(attribute(toggle(true), 'aria-label')).toBe(attribute(toggle(false), 'aria-label'));
    expect(attribute(toggle(true), 'title')).not.toBe(attribute(toggle(false), 'title'));
  });

  test('a low-spend chart keeps its dollar scale when expanded, so bars grow', () => {
    for (const peak of [1, 3.2, 4, 250]) {
      const [normal, tall] = [spendAxis(peak, false), spendAxis(peak, true)];
      expect(tall.scaleMax).toBe(normal.scaleMax);
      expect(tall.ticks).toHaveLength(normal.ticks.length * 2 - 1);
    }
  });
});
