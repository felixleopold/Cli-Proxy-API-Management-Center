import { describe, expect, test } from 'bun:test';
import { activeLenderReleases } from '../src/features/quota/hooks/useActiveOverrides';
import type { AuthFileItem } from '../src/types';

const file = (fields: Partial<AuthFileItem>) => ({ name: 'x.json', ...fields }) as AuthFileItem;

describe('active lender releases for the phone header', () => {
  test('lists each active lender with a running release once, soonest end first', () => {
    const now = 1_000;
    const releases = activeLenderReleases(
      [
        file({ lender: 'felix', lenderReserveOverrideUntilMs: 5_000 }),
        file({ lender: 'felix', lenderReserveOverrideUntilMs: 6_000 }),
        file({ lender: 'hanna', lenderReserveOverrideUntilMs: 3_000 }),
        file({ lender: 'disabled-lender', disabled: true, lenderReserveOverrideUntilMs: 4_000 }),
        file({ lender: 'mrak', lenderReserveOverrideUntilMs: 900 }),
        file({ lender: 'ferdinand' }),
        file({ lenderReserveOverrideUntilMs: 9_000 }),
      ],
      now
    );
    expect(releases).toEqual([
      { lender: 'hanna', untilMs: 3_000 },
      { lender: 'felix', untilMs: 5_000 },
    ]);
  });
});
