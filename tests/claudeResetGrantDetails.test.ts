import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { ClaudeResetGrantDetails } from '@/features/quota/providers/claude/ClaudeResetGrantDetails';
import { bindQuotaClasses, QUOTA_CLASS_KEYS } from '@/features/quota/types';
import type { AnthropicResetGrant } from '@/services/api/claudeResetGrants';
import { formatInstantShort } from '@/utils/quota';
import { resolveTimeZoneLabel } from '@/utils/time/timezone';

const classes = bindQuotaClasses(
  Object.fromEntries(QUOTA_CLASS_KEYS.map((key) => [key, key])),
  'test-host'
);
const expiry = Date.now() + 11 * 86400_000;
const grant = (overrides: Partial<AnthropicResetGrant> = {}): AnthropicResetGrant => ({
  id: 'launch',
  label: 'Launch',
  resetsTotal: 3,
  resetsLeft: 2,
  startsAt: null,
  endsAt: new Date(expiry).toISOString(),
  clears: ['five_hour'],
  paused: false,
  usableNow: true,
  useRequiresLimit: true,
  percentUsed: {},
  blocking: [],
  type: null,
  givesBackWeekly: false,
  unavailableReason: null,
  ...overrides,
});
type Props = Parameters<typeof ClaudeResetGrantDetails>[0];
const render = (grants: AnthropicResetGrant[], props: Partial<Props> = {}) =>
  renderToStaticMarkup(
    createElement(ClaudeResetGrantDetails, {
      grants,
      classes,
      blocker: () => null,
      locked: false,
      pendingGrantId: null,
      onRedeem: () => {},
      ...props,
    })
  );

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Claude reset grant details', () => {
  test('uses Codex detail classes, timezone, remaining count and live relative date', () => {
    const markup = render([grant()]);
    expect(markup).toContain('class="codexResetCredits"');
    expect(markup).toContain('class="codexResetCreditRow"');
    expect(markup).toContain(resolveTimeZoneLabel());
    expect(markup).toContain('Session reset (Launch) · 2 / 3 resets remaining');
    expect(markup).toContain(formatInstantShort(expiry));
    expect(markup).toContain('class="quotaResetRelative"');
    expect(markup).toContain('in 11 days');
  });

  test('hides empty and spent grants', () => {
    expect(render([])).toBe('');
    expect(render([grant({ resetsLeft: 0 })])).toBe('');
    expect(render([grant(), grant({ id: 'spent', label: 'Spent', resetsLeft: 0 })])).not.toContain(
      'Spent'
    );
  });

  test('sorts by deadline without mutating input and keeps unknown dates last', () => {
    const grants = [
      grant({ id: 'unknown', label: 'Unknown', endsAt: null }),
      grant({ id: 'later', label: 'Later', endsAt: new Date(expiry + 86400_000).toISOString() }),
      grant({ id: 'first', label: 'First' }),
    ];
    const markup = render(grants);
    expect(markup.indexOf('First')).toBeLessThan(markup.indexOf('Later'));
    expect(markup.indexOf('Later')).toBeLessThan(markup.indexOf('Unknown'));
    expect(markup).toContain('Expiry unknown');
    expect(grants.map((item) => item.id)).toEqual(['unknown', 'later', 'first']);
  });

  test('keeps paused and expired unspent grants visible without implying usability', () => {
    const markup = render(
      [grant({ paused: true, usableNow: false, endsAt: '2020-01-01T00:00:00Z' })],
      { blocker: () => 'Paused' }
    );
    expect(markup).toContain(formatInstantShort(Date.parse('2020-01-01T00:00:00Z')));
    expect(markup).toContain('Paused');
    expect(markup).not.toContain('<button');
  });

  test('usable grants get a Redeem button, the pending one Retry; give-back is stated', () => {
    const markup = render([
      grant({ clears: ['five_hour', 'seven_day'], percentUsed: { five_hour: 80 } }),
    ]);
    expect(markup).toContain('Frees 80% of your 5-hour limit, your weekly limit (amount unknown)');
    expect(markup).toMatch(/<button[^>]*><span>Redeem<\/span><\/button>/);
    expect(render([grant()], { locked: true })).toContain('disabled=""');
    expect(render([grant()], { pendingGrantId: 'launch' })).toContain('<span>Retry</span>');
    expect(
      render([grant({ givesBackWeekly: true, percentUsed: { seven_day_overage_included: 35 } })])
    ).toContain('Fable reset (Launch)');
  });

  test.each(['en', 'zh-CN', 'zh-TW', 'ru', 'vi'])(
    'translates fallback labels in %s',
    async (lng) => {
      await i18n.changeLanguage(lng);
      try {
        const markup = render([grant({ label: '', endsAt: null })]);
        expect(markup).toContain(i18n.t('claude_reset.kind.session'));
        expect(markup).toContain(i18n.t('claude_reset.redeem'));
        expect(markup).toContain(i18n.t('claude_reset.expiry_unknown'));
        expect(markup).not.toContain('claude_reset.');
      } finally {
        await i18n.changeLanguage('en');
      }
    }
  );
});
