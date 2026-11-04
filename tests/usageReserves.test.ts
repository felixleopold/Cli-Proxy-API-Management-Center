import { describe, expect, test } from 'bun:test';
import { parseDocument } from 'yaml';
import {
  readVisualUsageReserves,
  validateVisualUsageReserves,
  writeVisualUsageReserves,
} from '@/features/config/visualConfigUsageReserves';
import { normalizeAuthFilesResponse } from '@/services/api/authFiles';
import { normalizeUsagePoolReport, usagePoolApi } from '@/services/api/usagePool';
import {
  activePace,
  lenderReserves,
  parseKeepPercentText,
  resolveTimedChoice,
} from '@/features/quota/accountControls';
import { apiClient } from '@/services/api/client';
import {
  changeOverride,
  lenderReleaseUntil,
  overrideTarget,
  reportsFor,
  reserveStateOf,
  showsLenderRelease,
} from '@/features/quota/usagePoolModel';
import { DEFAULT_VISUAL_VALUES, type VisualConfigValues } from '@/types/visualConfig';

const SOURCE = `usage-reserves:
  timezone: Europe/Vienna
  quiet-hours:
    start: "23:00"
    end: "07:00"
  release-lead:
    five-hour: 15m
  people:
    Felix:
      reserve-percent: 10
`;

describe('usage-reserves config', () => {
  test('reads, edits and prunes back to gateway defaults', () => {
    const doc = parseDocument(SOURCE);
    const values: VisualConfigValues = {
      ...DEFAULT_VISUAL_VALUES,
      ...readVisualUsageReserves(doc),
    };
    expect(values.usageReservesPeople).toEqual([
      { id: 'person-0', name: 'Felix', reservePercent: '10' },
    ]);

    writeVisualUsageReserves(
      doc,
      {
        ...values,
        usageReservesLeadWeekly: '2h',
        usageReservesLeadFiveHour: '',
        usageReservesPeople: [
          ...values.usageReservesPeople,
          { id: 'new', name: ' Ferdinand ', reservePercent: '12.5' },
        ],
      },
      new Set(['usageReservesLeadWeekly', 'usageReservesLeadFiveHour', 'usageReservesPeople'])
    );
    expect(doc.toJS()['usage-reserves']).toEqual({
      timezone: 'Europe/Vienna',
      'quiet-hours': { start: '23:00', end: '07:00' },
      'release-lead': { weekly: '2h' },
      people: { Felix: { 'reserve-percent': 10 }, Ferdinand: { 'reserve-percent': 12.5 } },
    });

    writeVisualUsageReserves(
      doc,
      { ...values, usageReservesLeadWeekly: '', usageReservesPeople: [] },
      new Set(['usageReservesLeadWeekly', 'usageReservesPeople'])
    );
    expect(doc.toJS()['usage-reserves']).toEqual({
      timezone: 'Europe/Vienna',
      'quiet-hours': { start: '23:00', end: '07:00' },
    });
  });

  test('validates as the gateway parses: quiet hours as a pair, unique people, 0 ≤ reserve ≤ 100', () => {
    const errors = (patch: Partial<VisualConfigValues>) =>
      Object.entries(validateVisualUsageReserves({ ...DEFAULT_VISUAL_VALUES, ...patch })).filter(
        ([, error]) => error
      );
    expect(errors({ usageReservesQuietStart: '22:30', usageReservesQuietEnd: '6:00' })).toEqual([]);
    expect(errors({ usageReservesQuietStart: '22:30' })).toEqual([
      ['usageReservesQuietEnd', 'invalid_clock_pair'],
    ]);
    expect(
      errors({ usageReservesLeadWeekly: '1 hour', usageReservesTimezone: 'Mars/Base' })
    ).toEqual([
      ['usageReservesTimezone', 'invalid_timezone'],
      ['usageReservesLeadWeekly', 'invalid_duration'],
    ]);
    const person = (name: string, reservePercent: string) => ({ id: name, name, reservePercent });
    expect(errors({ usageReservesPeople: [person('Felix', '10'), person('felix', '5')] })).toEqual([
      ['usageReservesPeople', 'invalid_people'],
    ]);
    expect(errors({ usageReservesPeople: [person('Felix', '100.5')] })).toEqual([
      ['usageReservesPeople', 'invalid_people'],
    ]);
  });

  test('writes reserve floors as YAML numbers and rejects values outside 0..100', () => {
    const doc = parseDocument(SOURCE);
    const values: VisualConfigValues = {
      ...DEFAULT_VISUAL_VALUES,
      ...readVisualUsageReserves(doc),
      usageReservesFloorFiveHour: '0',
      usageReservesFloorWeekly: '2.5',
    };
    writeVisualUsageReserves(
      doc,
      values,
      new Set(['usageReservesFloorFiveHour', 'usageReservesFloorWeekly'])
    );
    expect(doc.toJS()['usage-reserves']['floor-percent']).toEqual({ 'five-hour': 0, weekly: 2.5 });
    expect(readVisualUsageReserves(doc).usageReservesFloorWeekly).toBe('2.5');

    const errors = validateVisualUsageReserves({
      ...values,
      usageReservesFloorFiveHour: '101',
      usageReservesFloorWeekly: '-1',
    });
    expect(errors.usageReservesFloorFiveHour).toBe('percent_range_0_100');
    expect(errors.usageReservesFloorWeekly).toBe('percent_range_0_100');
    expect(validateVisualUsageReserves(values).usageReservesFloorFiveHour).toBeUndefined();
  });

  test('accepts a person reserve of 0, which the gateway reads as no active reserve', () => {
    const values = {
      ...DEFAULT_VISUAL_VALUES,
      usageReservesPeople: [{ id: 'felix', name: 'Felix', reservePercent: '0' }],
    };
    expect(validateVisualUsageReserves(values).usageReservesPeople).toBeUndefined();
  });
});

describe('usage pool person scope', () => {
  const report = (name: string | null) =>
    normalizeUsagePoolReport({
      provider: 'claude',
      user: name === null ? null : { name, reserve_percent: 10 },
      windows: [],
    });

  test("never shows or targets the previous person's report after switching", () => {
    const loaded = { user: 'Felix', reports: [report('Felix')] };
    // Switched to Ferdinand; his fetch is pending or failed.
    const shown = reportsFor(loaded, 'Ferdinand');
    expect(shown).toEqual([]);
    expect(overrideTarget(shown, 'Ferdinand')).toBeNull();
    // Felix's own reports enable his switch; a stale mismatch never does.
    expect(overrideTarget(reportsFor(loaded, 'Felix'), 'Felix')).toBe('Felix');
    expect(overrideTarget([report('Felix')], 'Ferdinand')).toBeNull();
    expect(overrideTarget([report('felix')], 'Felix')).toBe('Felix');
    expect(overrideTarget([report(null)], '')).toBeNull();
  });
});

describe('usage pool override change', () => {
  test('skips the refresh when the person was switched while the change was in flight', async () => {
    let selected = 'Felix';
    let finish = () => {};
    const calls: string[] = [];
    const deps = {
      set: (user: string, on: boolean) => {
        calls.push(`set ${user} ${on}`);
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
      selected: () => selected,
      refresh: async () => {
        calls.push(`refresh ${selected}`);
      },
    };

    // Felix turns his override on, the panel switches to Ferdinand, and
    // Ferdinand's report loads before Felix's change returns.
    const change = changeOverride('Felix', true, deps);
    selected = 'Ferdinand';
    finish();
    await change;
    expect(calls).toEqual(['set Felix true']);

    // Without a switch the change still refreshes the shown person.
    selected = 'Felix';
    const unchanged = changeOverride('Felix', false, deps);
    finish();
    await unchanged;
    expect(calls).toEqual(['set Felix true', 'set Felix false', 'refresh Felix']);
  });
});

describe('usage pool report', () => {
  test('normalizes the gateway report and classifies lender reserves', () => {
    const report = normalizeUsagePoolReport({
      provider: 'claude',
      checked_at: '2026-11-02T10:00:00Z',
      user: { name: 'Felix', reserve_percent: 10, soft_stopped: false, override_until: null },
      active_account: { id: 'a', label: 'felix@x' },
      windows: [
        {
          kind: 'weekly',
          capacity: 15,
          left: 6,
          left_percent: 40,
          left_for_user_percent: 30,
          burn_per_hour: null,
          empty_at: null,
          refills: [{ at: '2026-11-03T10:00:00Z', units: 3, account_id: 'a' }],
          accounts: [
            {
              id: 'a',
              used_percent: 75,
              reserve_percent: 25,
              reserve_now_percent: 25,
              reserve_released: false,
            },
            {
              id: 'b',
              used_percent: 80,
              reserve_percent: 20,
              reserve_now_percent: 8,
              reserve_released: true,
            },
            // At the ceiling of the tapered reserve: 100 − 8.
            {
              id: 'd',
              used_percent: 92,
              reserve_percent: 20,
              reserve_now_percent: 8,
              reserve_released: true,
            },
            { id: 'c', used_percent: 10, reserve_percent: 0, reserve_now_percent: 0 },
            // A gateway before the taper: released meant the whole reserve.
            { id: 'old', used_percent: 90, reserve_percent: 25, reserve_released: true },
          ],
        },
      ],
    });
    const [weekly] = report.windows;
    expect(report.user?.overrideUntilMs).toBeNull();
    expect(weekly.burnPerHour).toBeNull();
    expect(weekly.refills).toEqual([
      { atMs: Date.parse('2026-11-03T10:00:00Z'), units: 3, accountId: 'a' },
    ]);
    expect(weekly.accounts.map(reserveStateOf)).toEqual([
      'reached',
      'tapering',
      'reached',
      'none',
      'tapering',
    ]);
    expect(weekly.accounts.map((account) => account.reserveNowPercent)).toEqual([25, 8, 8, 0, 0]);
  });
});

describe('lender reserve release', () => {
  const nowMs = Date.parse('2026-11-03T12:00:00Z');
  const credential = (fields: Record<string, unknown>) =>
    normalizeAuthFilesResponse({
      files: [{ name: 'a.json', type: 'claude', ...fields }],
    }).files[0];

  test('reads the lender and the end of its release', () => {
    const file = credential({
      lender: 'commercial',
      reserve_weekly_percent: 20,
      lender_reserve_override_until: '2026-11-03T14:30:00Z',
    });
    expect(file.lenderReserveOverrideUntilMs).toBe(Date.parse('2026-11-03T14:30:00Z'));
    expect(lenderReleaseUntil(file, nowMs)).toBe(file.lenderReserveOverrideUntilMs ?? null);
    expect(showsLenderRelease(file, nowMs)).toBe(true);
  });

  test('shows the control only for a lender with a reserve, and ignores an ended release', () => {
    expect(showsLenderRelease(credential({ lender: 'commercial' }), nowMs)).toBe(false);
    expect(showsLenderRelease(credential({ reserve_weekly_percent: 20 }), nowMs)).toBe(false);
    const ended = credential({
      lender: 'commercial',
      reserve_five_hour_percent: 10,
      lender_reserve_override_until: '2026-11-03T11:00:00Z',
    });
    expect(lenderReleaseUntil(ended, nowMs)).toBeNull();
    expect(showsLenderRelease(ended, nowMs)).toBe(true);
  });
});

describe('pace and reserve release controls', () => {
  const nowMs = Date.parse('2026-11-04T14:20:00Z');
  const HOUR = 3_600_000;
  const listed = (...files: Record<string, unknown>[]) =>
    normalizeAuthFilesResponse({ files: files.map((file, i) => ({ name: `${i}.json`, ...file })) })
      .files;

  test('resolves "until the next reset" to an instant, and refuses one nothing reports', () => {
    const resets = { fiveHour: nowMs + 2 * HOUR, weekly: null };
    expect(resolveTimedChoice({ kind: 'five_hour' }, resets, nowMs)).toEqual({
      span: { until: new Date(nowMs + 2 * HOUR).toISOString() },
      untilMs: nowMs + 2 * HOUR,
    });
    expect(resolveTimedChoice({ kind: 'weekly' }, resets, nowMs)).toBeNull();
    expect(resolveTimedChoice({ kind: 'hours', hours: 4 }, resets, nowMs)).toEqual({
      span: { duration: '4h' },
      untilMs: nowMs + 4 * HOUR,
    });
    expect(resolveTimedChoice({ kind: 'at', atMs: nowMs - 1 }, resets, nowMs)).toBeNull();
  });

  test('reads pace, nickname and routing status from the listing', () => {
    const [flash, unknown] = listed(
      {
        nickname: ' Max 5x ',
        pace_mode: 'flash',
        pace_until: '2026-11-04T17:20:00Z',
        routing_status: { state: 'target', reason: 'Flash', until: '2026-11-04T17:20:00Z' },
      },
      { pace_mode: 'snail', pace_until: '2026-11-04T17:20:00Z', routing_status: { state: 'odd' } }
    );
    expect(flash.nickname).toBe('Max 5x');
    expect(activePace(flash, nowMs)).toEqual({ mode: 'flash', untilMs: nowMs + 3 * HOUR });
    expect(activePace(flash, nowMs + 4 * HOUR)).toBeNull();
    expect(flash.routingStatus).toEqual({
      state: 'target',
      reason: 'Flash',
      untilMs: nowMs + 3 * HOUR,
    });
    expect(unknown.paceMode).toBeUndefined();
    expect(unknown.routingStatus).toBeUndefined();
  });

  test('groups lenders with their reserve, accounts, release and soonest resets', () => {
    const files = listed(
      {
        lender: 'commercial',
        reserve_five_hour_percent: 80,
        reserve_weekly_percent: 80,
        lender_reserve_override_until: '2026-11-04T17:00:00Z',
        lender_reserve_override_keep_percent: 50,
      },
      { lender: 'commercial', usage_cap_percent: 30 },
      { lender: 'felix', reserve_weekly_percent: 20 },
      { lender: 'felix', reserve_weekly_percent: 20, disabled: true },
      { lender: 'nobody' }
    );
    const resetsFor = (file: { name: string }) =>
      file.name === '0.json'
        ? { fiveHour: nowMs + HOUR, weekly: nowMs + 50 * HOUR }
        : { fiveHour: nowMs + 3 * HOUR, weekly: null };
    expect(lenderReserves(files, resetsFor, nowMs)).toEqual([
      {
        lender: 'commercial',
        accounts: 2,
        fiveHourPercent: 80,
        weeklyPercent: 80,
        release: { untilMs: Date.parse('2026-11-04T17:00:00Z'), keepPercent: 50 },
        resets: { fiveHour: nowMs + HOUR, weekly: nowMs + 50 * HOUR },
      },
      {
        lender: 'felix',
        accounts: 1,
        fiveHourPercent: null,
        weeklyPercent: 20,
        release: null,
        resets: { fiveHour: nowMs + 3 * HOUR, weekly: null },
      },
    ]);
  });
});

describe('release and pace requests', () => {
  test('keeps a share strictly between 0 and 100% of a released reserve; empty releases it all', () => {
    expect(parseKeepPercentText('')).toBeNull();
    expect(parseKeepPercentText(' 50 ')).toBe(50);
    expect(parseKeepPercentText('0.5')).toBe(0.5);
    expect(parseKeepPercentText('99.5')).toBe(99.5);
    for (const text of ['0', '100', '-5', 'abc']) {
      expect(parseKeepPercentText(text)).toBeUndefined();
    }
  });

  test('reads the end of a pace override from the gateway\'s `until`', async () => {
    const post = apiClient.post;
    const sent: unknown[] = [];
    apiClient.post = (async (_url: string, data?: unknown) => {
      sent.push(data);
      return { name: 'a.json', mode: 'flash', until: '2026-11-04T17:20:00Z' };
    }) as typeof apiClient.post;
    try {
      const untilMs = await usagePoolApi.setPace('a.json', 'flash', { duration: '4h' });
      expect(untilMs).toBe(Date.parse('2026-11-04T17:20:00Z'));
      expect(sent).toEqual([{ name: 'a.json', mode: 'flash', duration: '4h' }]);
    } finally {
      apiClient.post = post;
    }
  });
});
