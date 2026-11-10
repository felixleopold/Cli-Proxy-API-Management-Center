import { describe, expect, test } from 'bun:test';
import type { AuthFileItem } from '@/types';
import { accountSettingsDraft, buildAccountSettingsPatch } from '@/features/quota/accountSettings';
import { daysUntil, isRenewalSoon, resolveRenewal } from '@/features/quota/renewal';
import { normalizeAuthFilesResponse } from '@/services/api/authFiles';

const NOW = new Date(2026, 10, 10, 12).getTime();
const claude = (extra: Partial<AuthFileItem>) => ({ name: 'c.json', type: 'claude', ...extra });

describe('resolveRenewal', () => {
  test('Claude estimates the next monthly anniversary of the subscription start', () => {
    const file = claude({ subscriptionCreatedAtMs: Date.UTC(2026, 7, 21, 9, 30) });
    expect(resolveRenewal('claude', file, NOW)).toEqual({
      atMs: Date.UTC(2026, 10, 21, 9, 30),
      estimated: true,
    });
  });

  test('an anniversary day the month lacks clamps to the month end', () => {
    const file = claude({ subscriptionCreatedAtMs: Date.UTC(2026, 0, 31, 10) });
    const feb = new Date(2026, 1, 10, 12).getTime();
    expect(resolveRenewal('claude', file, feb)?.atMs).toBe(Date.UTC(2026, 1, 28, 10));
    const mar = new Date(2026, 2, 10, 12).getTime();
    expect(resolveRenewal('claude', file, mar)?.atMs).toBe(Date.UTC(2026, 2, 31, 10));
  });

  test('Codex is exact, taken from a loaded card before the file, and a past date is dropped', () => {
    const file = {
      name: 'x.json',
      type: 'codex',
      chatgpt_subscription_active_until: '2026-11-17T08:00:00Z',
    } as AuthFileItem;
    expect(resolveRenewal('codex', file, NOW)).toEqual({
      atMs: Date.UTC(2026, 10, 17, 8),
      estimated: false,
    });
    expect(resolveRenewal('codex', file, NOW, '2026-12-17T08:00:00Z')?.atMs).toBe(
      Date.UTC(2026, 11, 17, 8)
    );
    expect(resolveRenewal('codex', file, new Date(2026, 11, 1).getTime())).toBeNull();
  });

  test('the renewal day wins, is exact, and clamps to the month end', () => {
    const file = claude({ subscriptionCreatedAtMs: Date.UTC(2026, 7, 21), renewalDay: 17 });
    expect(resolveRenewal('claude', file, NOW)).toEqual({
      atMs: new Date(2026, 10, 17).getTime(),
      estimated: false,
    });
    expect(resolveRenewal('claude', claude({ renewalDay: 31 }), NOW)?.atMs).toBe(
      new Date(2026, 10, 30).getTime()
    );
    // Already past this month: next month.
    expect(resolveRenewal('claude', claude({ renewalDay: 3 }), NOW)?.atMs).toBe(
      new Date(2026, 11, 3).getTime()
    );
  });

  test('flags a renewal within five days, today included', () => {
    const today = { atMs: new Date(2026, 10, 10).getTime(), estimated: false };
    expect(daysUntil(today.atMs, NOW)).toBe(0);
    expect(isRenewalSoon(today, NOW)).toBe(true);
    expect(isRenewalSoon({ ...today, atMs: new Date(2026, 10, 15).getTime() }, NOW)).toBe(true);
    expect(isRenewalSoon({ ...today, atMs: new Date(2026, 10, 16).getTime() }, NOW)).toBe(false);
  });
});

describe('renewal day setting and listing', () => {
  test('saves a valid day, clears with empty, rejects the rest, and is Claude and Codex only', () => {
    const seed = accountSettingsDraft({});
    expect(buildAccountSettingsPatch('claude', seed, { ...seed, renewalDay: ' 17 ' })).toEqual({
      patch: { renewal_day: 17 },
    });
    expect(
      buildAccountSettingsPatch('codex', { ...seed, renewalDay: '17' }, { ...seed, renewalDay: '' })
    ).toEqual({ patch: { renewal_day: null } });
    for (const bad of ['0', '32', '1.5', 'x']) {
      expect(buildAccountSettingsPatch('claude', seed, { ...seed, renewalDay: bad })).toEqual({
        error: 'renewal_day',
      });
    }
    expect(buildAccountSettingsPatch('gemini', seed, { ...seed, renewalDay: '17' })).toEqual({
      patch: {},
    });
  });

  test('reads the subscription start and a valid renewal day from the listing', () => {
    const { files } = normalizeAuthFilesResponse({
      files: [
        {
          name: 'a.json',
          subscription_created_at: '2026-08-21T09:30:00Z',
          renewal_day: 17,
        },
        { name: 'b.json', renewal_day: 40 },
      ],
    });
    expect(files[0].subscriptionCreatedAtMs).toBe(Date.UTC(2026, 7, 21, 9, 30));
    expect(files[0].renewalDay).toBe(17);
    expect(files[1].renewalDay).toBeUndefined();
  });
});
