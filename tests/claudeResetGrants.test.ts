import { selectResetGrant } from '../src/features/quota/providers/claude/selectResetGrant';

import { afterEach, describe, expect, test } from 'bun:test';
import {
  anthropicResetGrantBlocker,
  claimClaudeResetGrant,
  parseAnthropicResetGrantStatus,
  readClaudeOrganization,
  readClaudeResetGrants,
  AnthropicResetGrantUnknownOutcome,
  ANTHROPIC_RESET_RESULTS,
  type AnthropicResetClaimAnswer,
  type AnthropicResetSettledCode,
} from '../src/services/api/claudeResetGrants';
import {
  resetGrantBlock,
  resetGrantGivesBack,
  resetGrantKind,
} from '../src/features/quota/providers/claude/resetGrantInfo';
import { apiCallApi, type ApiCallRequest } from '../src/services/api/apiCall';
import {
  createResetGrantOperations,
  RETRY_WINDOW_MS,
} from '../src/features/quota/providers/claude/resetGrantOperations';

const organization = '11111111-2222-3333-4444-555555555555';
const grant = { id: 'test-grant', resets_total: 2, resets_left: 2, usable_now: true };
const block = { eligible: true, at_limit: true, grants: [grant] };
const status = () => parseAnthropicResetGrantStatus(block)!;
const originalRequest = apiCallApi.request;
afterEach(() => {
  apiCallApi.request = originalRequest;
});

describe('Claude reset grant fail-closed parsing', () => {
  test('valid block and refusing defaults', () => {
    expect(status().grants[0].useRequiresLimit).toBe(true);
    expect(anthropicResetGrantBlocker(status(), grant.id)).toBeNull();
    expect(anthropicResetGrantBlocker({ ...status(), atLimit: false }, grant.id)).toBe(
      'not_limited'
    );
    expect(anthropicResetGrantBlocker({ ...status(), eligible: false }, grant.id)).toBe(
      'ineligible'
    );
    const missing = parseAnthropicResetGrantStatus({
      ...block,
      grants: [{ ...grant, usable_now: undefined }],
    })!;
    expect(anthropicResetGrantBlocker(missing, grant.id)).toBe('not_usable');
  });
  test('rejects malformed blocks and grants', () => {
    for (const value of [
      undefined,
      {},
      { ...block, eligible: 1 },
      { ...block, grants: {} },
      { ...block, grants: [grant, grant] },
      { ...block, cooldown_until: 'bad' },
    ]) {
      expect(parseAnthropicResetGrantStatus(value)).toBeNull();
    }
    for (const fields of [
      { id: '../bad' },
      { resets_left: -1 },
      { resets_left: 3 },
      { resets_total: 1.5 },
      { paused: 'false' },
      { starts_at: 'bad' },
      { clears: {} },
    ]) {
      expect(
        parseAnthropicResetGrantStatus({ ...block, grants: [{ ...grant, ...fields }] })
      ).toBeNull();
    }
  });
});

test('exact proxied GET/profile/claim contract, no provider token in frontend', async () => {
  const calls: ApiCallRequest[] = [];
  apiCallApi.request = async (request) => {
    calls.push(request);
    const body =
      request.method === 'POST'
        ? { result: 'reset' }
        : request.url.endsWith('profile')
          ? { organization: { uuid: organization } }
          : { cedar_ember: block };
    return { statusCode: 200, body, bodyText: '', header: {} };
  };
  await readClaudeResetGrants('index');
  expect(await readClaudeOrganization('index')).toBe(organization);
  expect((await claimClaudeResetGrant('index', organization, grant.id, 'request-1')).code).toBe(
    'reset'
  );
  expect(calls[0].url).toBe('https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1');
  expect(calls[1].url).toBe('https://api.anthropic.com/api/oauth/profile');
  expect(calls[2].url).toBe(
    `https://api.anthropic.com/api/organizations/${organization}/reset_rate_limits`
  );
  expect(JSON.parse(calls[2].data!)).toEqual({
    program: 'cedar_ember',
    grant_id: grant.id,
    request_id: 'request-1',
  });
  for (const call of calls) {
    expect(call.authIndex).toBe('index');
    expect(call.header?.Authorization).toBe('Bearer $TOKEN$');
    expect(call.header?.['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(call.header?.['User-Agent']).toBe('claude-cli/2.1.280 (external, cli)');
  }
});

test('claim terminal mappings and ambiguous outcomes', async () => {
  for (const result of ANTHROPIC_RESET_RESULTS) {
    apiCallApi.request = async () => ({
      statusCode: 200,
      body: { result },
      bodyText: '',
      header: {},
    });
    expect((await claimClaudeResetGrant('a', organization, grant.id, 'r')).code).toBe(result);
  }
  for (const [statusCode, code] of [
    [401, 'auth_error'],
    [403, 'auth_error'],
    [429, 'rate_limited'],
  ] as const) {
    apiCallApi.request = async () => ({ statusCode, body: null, bodyText: '', header: {} });
    expect((await claimClaudeResetGrant('a', organization, grant.id, 'r')).code).toBe(code);
  }
  for (const statusCode of [200, 400, 500]) {
    apiCallApi.request = async () => ({
      statusCode,
      body: { result: 'unexpected' },
      bodyText: '',
      header: {},
    });
    await expect(claimClaudeResetGrant('a', organization, grant.id, 'r')).rejects.toBeInstanceOf(
      AnthropicResetGrantUnknownOutcome
    );
  }
  apiCallApi.request = async () => {
    throw new Error('private upstream detail');
  };
  await expect(claimClaudeResetGrant('a', organization, grant.id, 'r')).rejects.toThrow(
    'outcome is unknown'
  );
});

const answer = (code: AnthropicResetSettledCode): AnthropicResetClaimAnswer => ({
  code,
  reason: null,
  resetsLeft: null,
  cleared: [],
  weeklyResetsAt: null,
  cooldownUntil: null,
});

function setup() {
  let revision = 1;
  let now = 100;
  let count = 0;
  const ids: string[] = [];
  const deps = {
    revision: () => revision,
    now: () => now,
    requestId: () => `request-${++count}`,
    readStatus: async () => status(),
    readOrganization: async () => organization,
    claim: async (
      _auth: string,
      _org: string,
      _grant: string,
      id: string
    ): Promise<AnthropicResetClaimAnswer> => {
      ids.push(id);
      throw new AnthropicResetGrantUnknownOutcome();
    },
  };
  return {
    deps,
    ids,
    nextSession: () => {
      revision++;
    },
    advance: () => {
      now += RETRY_WINDOW_MS;
    },
  };
}

test('unknown outcome retains request ID across retries; expiry blocks', async () => {
  const h = setup();
  const operations = createResetGrantOperations(h.deps);
  await expect(operations.run('account', 'a', grant.id)).rejects.toThrow();
  await expect(operations.run('account', 'a', grant.id)).rejects.toThrow();
  expect(h.ids).toEqual(['request-1', 'request-1']);
  await expect(operations.run('account', 'a', 'other-grant')).rejects.toThrow('expired');
  h.advance();
  await expect(operations.run('account', 'a', grant.id)).rejects.toThrow('expired');
  expect(h.ids).toHaveLength(2);
});

test('fresh spend rechecks eligibility and blocks concurrent clicks', async () => {
  const h = setup();
  h.deps.readStatus = async () => ({ ...status(), eligible: false });
  const operations = createResetGrantOperations(h.deps);
  const first = operations.run('account', 'a', grant.id);
  await expect(operations.run('account', 'a', grant.id)).rejects.toThrow('busy');
  await expect(first).rejects.toThrow('blocked');
  expect(h.ids).toHaveLength(0);
});

test('session change during profile read prevents POST and isolates journal', async () => {
  const h = setup();
  const operations = createResetGrantOperations(h.deps);
  await expect(operations.run('account', 'a', grant.id)).rejects.toThrow();
  h.nextSession();
  expect(operations.inspect('account')).toBeUndefined();
  h.deps.readOrganization = async () => {
    h.nextSession();
    return organization;
  };
  await expect(operations.run('account', 'a', grant.id)).rejects.toThrow('session');
  expect(h.ids).toHaveLength(1);
});

test('retry binds original organization', async () => {
  const h = setup();
  const operations = createResetGrantOperations(h.deps);
  await expect(operations.run('account', 'a', grant.id)).rejects.toThrow();
  h.deps.readOrganization = async () => 'aaaaaaaa-2222-3333-4444-555555555555';
  await expect(operations.run('account', 'a', grant.id)).rejects.toThrow('identity');
  expect(h.ids).toHaveLength(1);
});

test('a retry refusal keeps the ambiguous original operation open', async () => {
  const h = setup();
  const operations = createResetGrantOperations(h.deps);
  await expect(operations.run('account', 'a', grant.id)).rejects.toThrow();
  h.deps.claim = async (_auth, _org, _grant, id) => {
    h.ids.push(id);
    return answer('rate_limited');
  };
  expect(await operations.run('account', 'a', grant.id)).toEqual({
    ...answer('rate_limited'),
    unresolved: true,
  });
  expect(operations.inspect('account')?.code).toBeUndefined();
  h.deps.claim = async (_auth, _org, _grant, id) => {
    h.ids.push(id);
    return answer('already_used');
  };
  expect(await operations.run('account', 'a', grant.id)).toEqual({
    ...answer('already_used'),
    unresolved: false,
  });
  expect(h.ids).toEqual(['request-1', 'request-1', 'request-1']);
});

test('no retry after the deadline expires during profile lookup', async () => {
  const h = setup();
  const operations = createResetGrantOperations(h.deps);
  await expect(operations.run('account', 'a', grant.id)).rejects.toThrow();
  h.deps.readOrganization = async () => {
    h.advance();
    return organization;
  };
  await expect(operations.run('account', 'a', grant.id)).rejects.toThrow('expired');
  expect(h.ids).toHaveLength(1);
});

test('date, pause, limit, balance, usability and cooldown gates refuse new spending', async () => {
  for (const fields of [
    { paused: true },
    { resetsLeft: 0 },
    { usableNow: false },
    { startsAt: '2099-01-01T00:00:00Z' },
    { endsAt: '1970-01-01T00:00:00Z' },
  ]) {
    const h = setup();
    h.deps.readStatus = async () => ({
      ...status(),
      grants: [{ ...status().grants[0], ...fields }],
    });
    await expect(createResetGrantOperations(h.deps).run('account', 'a', grant.id)).rejects.toThrow(
      'blocked'
    );
    expect(h.ids).toHaveLength(0);
  }
  for (const fields of [{ atLimit: false }, { cooldownUntil: '2099-01-01T00:00:00Z' }]) {
    const h = setup();
    h.deps.readStatus = async () => ({ ...status(), ...fields });
    await expect(createResetGrantOperations(h.deps).run('account', 'a', grant.id)).rejects.toThrow(
      'blocked'
    );
    expect(h.ids).toHaveLength(0);
  }
});

test('a stale claim answer cannot settle the replacement session operation', async () => {
  const h = setup();
  const operations = createResetGrantOperations(h.deps);
  h.deps.claim = async () => {
    h.nextSession();
    expect(operations.inspect('account')).toBeUndefined();
    return answer('reset');
  };
  await expect(operations.run('account', 'a', grant.id)).rejects.toThrow('session');
  expect(operations.inspect('account')).toBeUndefined();
});

test('all grant messages and confirmation are translated in every locale', async () => {
  const locales = await Promise.all(
    ['en', 'zh-CN', 'zh-TW', 'ru', 'ko', 'vi'].map(
      async (locale) => (await Bun.file(`src/i18n/locales/${locale}.json`).json()).claude_reset
    )
  );
  const keys = (value: Record<string, unknown>, prefix = ''): string[] =>
    Object.entries(value)
      .flatMap(([key, child]) =>
        typeof child === 'object' && child !== null
          ? keys(child as Record<string, unknown>, `${prefix}${key}.`)
          : [`${prefix}${key}`]
      )
      .sort();
  for (const locale of locales) {
    expect(keys(locale)).toEqual(keys(locales[0]));
    expect(locale.confirm_text).toContain('{{name}}');
    expect(locale.retry_confirm).toContain('{{name}}');
    expect(typeof locale.remaining).toBe('string');
    expect(locale.count).toContain('{{left}}');
    for (const key of [
      ...ANTHROPIC_RESET_RESULTS,
      'auth_error',
      'rate_limited',
      'unknown',
      'expired',
    ]) {
      expect(typeof locale[key]).toBe('string');
    }
  }
});

test('card selection prefers usable recommendation and has deterministic fallback', () => {
  const base = status();
  const a = { ...base.grants[0], id: 'a' };
  const b = { ...a, id: 'b' };
  const multiple = { ...base, grants: [b, a], nextGrantId: 'b' };
  expect(selectResetGrant(multiple, 0)?.id).toBe('b');
  expect(selectResetGrant({ ...multiple, nextGrantId: null }, 0)?.id).toBe('a');
  expect(selectResetGrant({ ...multiple, grants: [a, { ...b, paused: true }] }, 0)?.id).toBe('a');
  expect(selectResetGrant({ ...multiple, eligible: false }, 0)).toBeUndefined();
  expect(selectResetGrant({ ...multiple, atLimit: false }, 0)).toBeUndefined();
  expect(
    selectResetGrant({ ...multiple, cooldownUntil: new Date(1000).toISOString() }, 0)
  ).toBeUndefined();
  for (const changed of [
    { resetsLeft: 0 },
    { usableNow: false },
    { paused: true },
    { startsAt: new Date(1000).toISOString() },
    { endsAt: new Date(0).toISOString() },
  ]) {
    expect(selectResetGrant({ ...base, grants: [{ ...a, ...changed }] }, 0)).toBeUndefined();
  }
});

test('Claude row shows the count and grant details and uses the shared confirmation, not a grant dialog', async () => {
  const card = await Bun.file('src/features/quota/components/QuotaAccountRow.tsx').text();
  const hook = await Bun.file('src/features/quota/providers/claude/ClaudeResetGrants.tsx').text();
  expect(card).toContain("{claudeReset.count ?? '—'}");
  expect(card).toContain('grants={claudeGrants}');
  expect(card).toContain('onRedeem={claudeReset.confirm}');
  expect(card).toContain('disabled={claudeReset.blocked}');
  expect(card).toContain('onClick={() => claudeReset.confirm()}');
  expect(hook).toContain('showConfirmation({');
  expect(hook).toContain("pending ? 'claude_reset.retry_confirm'");
  expect(hook).not.toContain('<Modal');
  expect(hook).not.toContain('status.grants.map');
});

describe('full grant shape', () => {
  const full = {
    ...grant,
    clears: ['five_hour', 'seven_day', 'seven_day_future', 7],
    blocking: ['seven_day_opus', 'brand_new'],
    percent_used: { five_hour: 80, seven_day: 40, brand_new: 10 },
    type: 'full',
    gives_back_weekly: false,
    unavailable_reason: 'blocked_opus',
  };
  test('parses new fields and drops unknown windows without rejecting the block', () => {
    const parsed = parseAnthropicResetGrantStatus({
      ...block,
      exhausted: ['seven_day_sonnet', 'later_window'],
      grants: [full],
    })!;
    expect(parsed.exhausted).toEqual(['seven_day_sonnet']);
    expect(parsed.grants[0]).toMatchObject({
      clears: ['five_hour', 'seven_day'],
      blocking: ['seven_day_opus'],
      percentUsed: { five_hour: 80, seven_day: 40 },
      type: 'full',
      givesBackWeekly: false,
      unavailableReason: 'blocked_opus',
    });
    const odd = parseAnthropicResetGrantStatus({
      ...block,
      grants: [{ ...full, type: 'mystery', unavailable_reason: 'new_reason' }],
    })!.grants[0];
    expect(odd.type).toBeNull();
    expect(odd.unavailableReason).toBe('unavailable');
    for (const fields of [{ gives_back_weekly: 'yes' }, { blocking: 'five_hour' }]) {
      expect(
        parseAnthropicResetGrantStatus({ ...block, grants: [{ ...grant, ...fields }] })
      ).toBeNull();
    }
  });

  test('kind follows the CLI rule', () => {
    const base = status().grants[0];
    expect(resetGrantKind({ ...base, givesBackWeekly: true, type: 'session' })).toBe('fable');
    expect(resetGrantKind({ ...base, type: 'weekly', clears: ['five_hour'] })).toBe('weekly');
    expect(resetGrantKind({ ...base, clears: ['five_hour'] })).toBe('session');
    expect(resetGrantKind({ ...base, clears: ['seven_day'] })).toBe('weekly');
    expect(resetGrantKind({ ...base, clears: ['five_hour', 'seven_day'] })).toBe('full');
  });

  test('give-back lists cleared windows largest first, Fable returns its own window', () => {
    const base = status().grants[0];
    expect(
      resetGrantGivesBack({
        ...base,
        clears: ['five_hour', 'seven_day', 'seven_day_opus'],
        percentUsed: { five_hour: 30, seven_day: 70 },
      })
    ).toEqual([
      { window: 'seven_day', percent: 70 },
      { window: 'five_hour', percent: 30 },
      { window: 'seven_day_opus', percent: null },
    ]);
    expect(
      resetGrantGivesBack({
        ...base,
        givesBackWeekly: true,
        clears: ['seven_day'],
        percentUsed: { seven_day: 90, seven_day_overage_included: 55 },
      })
    ).toEqual([{ window: 'seven_day_overage_included', percent: 55 }]);
  });

  test('blocker reasons name the gate the panel refuses on', () => {
    const s = status();
    const g = s.grants[0];
    const block = (st: Partial<typeof s>, gr: Partial<typeof g> = {}) =>
      resetGrantBlock({ ...s, ...st }, { ...g, ...gr }, 0);
    expect(block({})).toBeNull();
    expect(block({ eligible: false, ineligibleReason: 'tier' })).toEqual({
      code: 'ineligible',
      reason: 'tier',
    });
    expect(block({}, { paused: true })).toEqual({ code: 'paused' });
    expect(block({}, { startsAt: new Date(1000).toISOString() })).toEqual({
      code: 'not_started',
      at: new Date(1000).toISOString(),
    });
    expect(block({ cooldownUntil: new Date(1000).toISOString() })).toEqual({
      code: 'cooldown',
      until: new Date(1000).toISOString(),
    });
    expect(block({ atLimit: false })).toEqual({ code: 'needs_limit' });
    expect(block({}, { usableNow: false, unavailableReason: 'needs_limit' })).toEqual({
      code: 'needs_limit',
    });
    expect(block({}, { usableNow: false, unavailableReason: 'blocked_sonnet' })).toEqual({
      code: 'blocked',
      windows: ['seven_day_sonnet'],
    });
    expect(
      block({}, { usableNow: false, unavailableReason: 'blocked_other', blocking: ['seven_day'] })
    ).toEqual({ code: 'blocked', windows: ['seven_day'] });
    expect(block({}, { usableNow: false, unavailableReason: null })).toEqual({
      code: 'unavailable',
    });
    // The fresh-spend gate and the panel agree.
    for (const changed of [{ usableNow: false }, { paused: true }, { resetsLeft: 0 }]) {
      const st = { ...s, grants: [{ ...g, ...changed }] };
      expect(Boolean(anthropicResetGrantBlocker(st, g.id))).toBe(true);
      expect(resetGrantBlock(st, st.grants[0], 0)).not.toBeNull();
    }
  });

  test('claim answer carries reason, cleared windows and balance; bad details are dropped', async () => {
    apiCallApi.request = async () => ({
      statusCode: 200,
      body: {
        result: 'reset',
        reason: 'ok\u0007 done',
        resets_left: 1,
        cleared: ['five_hour', 'unknown_window'],
        cooldown_until: 'bad',
      },
      bodyText: '',
      header: {},
    });
    expect(await claimClaudeResetGrant('a', organization, grant.id, 'r')).toEqual({
      code: 'reset',
      reason: 'ok done',
      resetsLeft: 1,
      cleared: ['five_hour'],
      weeklyResetsAt: null,
      cooldownUntil: null,
    });
  });
});
