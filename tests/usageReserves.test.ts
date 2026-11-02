import { describe, expect, test } from 'bun:test';
import { parseDocument } from 'yaml';
import {
  readVisualUsageReserves,
  validateVisualUsageReserves,
  writeVisualUsageReserves,
} from '@/features/config/visualConfigUsageReserves';
import { normalizeUsagePoolReport } from '@/services/api/usagePool';
import {
  changeOverride,
  overrideTarget,
  reportsFor,
  reserveStateOf,
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
