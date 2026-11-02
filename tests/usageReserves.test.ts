import { describe, expect, test } from 'bun:test';
import { parseDocument } from 'yaml';
import {
  readVisualUsageReserves,
  validateVisualUsageReserves,
  writeVisualUsageReserves,
} from '@/features/config/visualConfigUsageReserves';
import { normalizeUsagePoolReport } from '@/services/api/usagePool';
import { reserveStateOf } from '@/features/quota/usagePoolModel';
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

  test('validates as the gateway parses: quiet hours as a pair, unique people, 0 < reserve ≤ 100', () => {
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
    expect(errors({ usageReservesPeople: [person('Felix', '0')] })).toEqual([
      ['usageReservesPeople', 'invalid_people'],
    ]);
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
            { id: 'a', weight: 10, used_percent: 75, reserve_percent: 25, reserve_released: false },
            { id: 'b', weight: 5, used_percent: 80, reserve_percent: 25, reserve_released: true },
            { id: 'c', weight: 1, used_percent: 10, reserve_percent: 0 },
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
    expect(weekly.accounts.map(reserveStateOf)).toEqual(['reached', 'released', 'none']);
  });
});
