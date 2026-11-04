import { describe, expect, test } from 'bun:test';
import { accountWindows } from '@/features/quota/accountCards';
import { classifyQuotaFiles, disabledAccountFiles } from '@/features/quota/logic';
import type { AuthFileItem } from '@/types';
import { accountSettingsDraft, buildAccountSettingsPatch } from '@/features/quota/accountSettings';
import { planShareOf } from '@/features/quota/planMultipliers';
import type { CardReading, PoolCredential } from '@/features/quota/quotaForecastModel';
import { countdownParts } from '@/utils/quota/relativeTime';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';

const NOW = Date.UTC(2026, 10, 4, 12, 0);
const WEEK_MS = 7 * DAY_MS;
const share = planShareOf({ type: 'claude' }, 'weekly');

const pooled = (window: PoolCredential['window'], usedPercent: number, resetAtMs: number) =>
  ({
    authId: 'a',
    window,
    periodMs: window === 'weekly' ? WEEK_MS : 5 * HOUR_MS,
    usedPercent,
    resetAtMs,
    observedAtMs: null,
    share,
  }) satisfies PoolCredential;

const card: CardReading = {
  usedPercent: 40,
  resetAtMs: NOW + 2 * DAY_MS,
  periodMs: WEEK_MS,
  short: { usedPercent: 10, resetAtMs: NOW + HOUR_MS, periodMs: 5 * HOUR_MS },
};

describe('countdownParts', () => {
  test('pairs days with hours and truncates, so it never claims more time than remains', () => {
    expect(countdownParts(NOW + DAY_MS + 3 * HOUR_MS + 59 * MINUTE_MS, NOW)).toEqual({
      days: 1,
      hours: 3,
      minutes: 59,
    });
    expect(countdownParts(NOW + 2 * DAY_MS, NOW)).toEqual({ days: 2, hours: 0, minutes: 0 });
    expect(countdownParts(NOW + 30_000, NOW)).toEqual({ days: 0, hours: 0, minutes: 0 });
    expect(countdownParts(NOW, NOW)).toBeNull();
    expect(countdownParts(NOW - MINUTE_MS, NOW)).toBeNull();
  });
});

describe('accountWindows', () => {
  test('takes the pooled weekly reading and the 5-hour window from the loaded card', () => {
    const windows = accountWindows({
      pooled: pooled('weekly', 70, NOW + DAY_MS),
      card,
      liveShort: null,
      nowMs: NOW,
    });
    expect(windows.long).toEqual({ leftPercent: 30, resetAtMs: NOW + DAY_MS, periodMs: WEEK_MS });
    expect(windows.short?.leftPercent).toBe(90);
  });

  test('a passed reset reads as a full window; the live 5-hour reading keeps its reset', () => {
    const windows = accountWindows({
      pooled: pooled('weekly', 95, NOW - HOUR_MS),
      card: null,
      liveShort: { minutes: 300, usedPercent: 25, resetAtMs: NOW + 2 * HOUR_MS },
      nowMs: NOW,
    });
    expect(windows.long).toEqual({
      leftPercent: 100,
      resetAtMs: NOW - HOUR_MS + WEEK_MS,
      periodMs: WEEK_MS,
    });
    expect(windows.short).toEqual({
      leftPercent: 75,
      resetAtMs: NOW + 2 * HOUR_MS,
      periodMs: 5 * HOUR_MS,
    });
  });

  test('leaves a window nothing reports unknown instead of guessing', () => {
    expect(accountWindows({ pooled: null, card: null, liveShort: null, nowMs: NOW })).toEqual({
      short: null,
      long: null,
    });
    // A card with only its 5-hour window has no weekly one.
    const onlyShort: CardReading = { ...card, periodMs: 5 * HOUR_MS, resetAtMs: NOW + HOUR_MS };
    const windows = accountWindows({ pooled: null, card: onlyShort, liveShort: null, nowMs: NOW });
    expect(windows.long).toBeNull();
    expect(windows.short?.leftPercent).toBe(90);
  });
});

describe('account settings patch', () => {
  const file = {
    priority: 5,
    weight: 2,
    plan: 'max',
    planMultiplier: 10,
    usageCapPercent: 75,
    lender: 'Ferdinand',
    reserveFiveHourPercent: 25,
    reserveWeeklyPercent: 25,
  };
  const seed = accountSettingsDraft(file);

  test('saves only the fields that changed', () => {
    expect(buildAccountSettingsPatch('claude', seed, seed)).toEqual({ patch: {} });
    expect(
      buildAccountSettingsPatch('claude', seed, {
        ...seed,
        priority: '',
        weight: ' 2 ',
        plan: 'ultra',
        reserveWeekly: '40',
        lender: '',
      })
    ).toEqual({
      patch: { priority: 0, plan: 'ultra', reserve_weekly_percent: 40, lender: null },
    });
  });

  test('saves the name for any provider and the multiplier only without a weighed plan', () => {
    expect(buildAccountSettingsPatch('gemini', seed, { ...seed, nickname: '  Spare  ' })).toEqual({
      patch: { nickname: 'Spare' },
    });
    expect(buildAccountSettingsPatch('claude', { ...seed, nickname: 'Old' }, seed)).toEqual({
      patch: { nickname: null },
    });
    // Max sets the multiplier; a value typed under Custom before switching back is dropped.
    expect(buildAccountSettingsPatch('claude', seed, { ...seed, planMultiplier: '3' })).toEqual({
      patch: {},
    });
    expect(
      buildAccountSettingsPatch('claude', seed, { ...seed, plan: '', planMultiplier: '3' })
    ).toEqual({ patch: { plan: null, plan_multiplier: 3 } });
  });

  test('clears with null, rejects invalid text, and keeps pooled fields off other providers', () => {
    expect(
      buildAccountSettingsPatch('codex', seed, { ...seed, planMultiplier: '', usageCap: '' })
    ).toEqual({ patch: { plan_multiplier: null, usage_cap_percent: null } });
    expect(buildAccountSettingsPatch('claude', seed, { ...seed, reserveFiveHour: '120' })).toEqual({
      error: 'reserve',
    });
    expect(buildAccountSettingsPatch('claude', seed, { ...seed, weight: '1.5' })).toEqual({
      error: 'weight_integer',
    });
    expect(
      buildAccountSettingsPatch('gemini', seed, { ...seed, lender: 'Felix', weight: '3' })
    ).toEqual({ patch: { weight: 3 } });
  });
});

describe('disabledAccountFiles', () => {
  const files = [
    { name: 'claude-on.json', provider: 'claude' },
    { name: 'claude-off.json', provider: 'claude', disabled: true, email: 'off@example.com' },
    { name: 'gemini-off.json', provider: 'gemini', disabled: true },
  ] as AuthFileItem[];

  test('keeps disabled credentials listable by tab and search, while quota entries skip them', () => {
    expect(classifyQuotaFiles(files).map((entry) => entry.file.name)).toEqual(['claude-on.json']);
    const names = (tab: string, search = '') =>
      disabledAccountFiles(files, tab, search).map((file) => file.name);
    expect(names('all')).toEqual(['claude-off.json', 'gemini-off.json']);
    expect(names('claude')).toEqual(['claude-off.json']);
    expect(names('gemini')).toEqual(['gemini-off.json']);
    expect(names('all', 'off@')).toEqual(['claude-off.json']);
  });
});
