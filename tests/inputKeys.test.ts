import { afterEach, expect, test } from 'bun:test';
import { apiClient } from '../src/services/api/client';
import { clientKeysApi, normalizeClientKey } from '../src/services/api/clientKeys';
import { inputKeysApi, serializeInputKeySettings } from '../src/services/api/inputKeys';
import {
  groupChoices,
  inputKeyLabel,
  inputKeyLimit,
  inputKeyScope,
  parseCycleDay,
  parseLimitUsd,
} from '../src/features/clientKeys/inputKeysModel';

const originalGet = apiClient.get;
const originalPost = apiClient.post;
const originalPatch = apiClient.patch;
afterEach(() => {
  apiClient.get = originalGet;
  apiClient.post = originalPost;
  apiClient.patch = originalPatch;
});

test('lists only API-key credentials and normalizes their settings', async () => {
  apiClient.get = (async () => ({
    files: [
      { id: 'claude-felix.json', name: 'claude-felix.json', provider: 'claude', source: 'file' },
      {
        id: 'claude:apikey:0123456789ab',
        name: 'claude-2',
        provider: 'claude',
        auth_kind: 'api-key',
        client_keys_only: true,
        serve_client_keys: false,
        credential_groups: ['commercial'],
        billing_cycle_day: 15,
        monthly_limit_usd: 10,
        cycle_start: '2026-11-15T00:00:00Z',
        spent_usd_cycle: 1.2,
        unpriced_usage_cycle: true,
        limit_reached: false,
      },
      { id: 'gemini:apikey:aaaaaaaaaaaa', provider: 'gemini', serve_client_keys: false },
    ],
  })) as typeof apiClient.get;

  const keys = await inputKeysApi.list();
  expect(keys.map((key) => key.id)).toEqual([
    'claude:apikey:0123456789ab',
    'gemini:apikey:aaaaaaaaaaaa',
  ]);
  const [claude, gemini] = keys;
  // client-keys-only implies serving client keys.
  expect(claude).toMatchObject({
    serveClientKeys: true,
    clientKeysOnly: true,
    credentialGroups: ['commercial'],
    billingCycleDay: 15,
    monthlyLimitUsd: 10,
    cycleStartMs: Date.UTC(2026, 10, 15),
    spentUsdCycle: 1.2,
    unpricedUsageCycle: true,
  });
  expect(inputKeyScope(claude)).toBe('client_only');
  // Defaults for a backend without the spend fields.
  expect(gemini).toMatchObject({ billingCycleDay: 1, monthlyLimitUsd: 0, spentUsdCycle: null });
  expect(inputKeyScope(gemini)).toBe('device_only');
  expect(inputKeyLabel(gemini)).toBe('apikey:aaaaaaaaaaaa');
});

test('limit state: unlimited, near, over by spend or by the gateway flag', () => {
  const base = {
    id: 'x',
    name: 'x',
    provider: 'claude',
    disabled: false,
    serveClientKeys: false,
    clientKeysOnly: false,
    credentialGroups: [],
    billingCycleDay: 1,
    cycleStartMs: null,
    unpricedUsageCycle: false,
    limitReached: false,
  };
  expect(inputKeyLimit({ ...base, monthlyLimitUsd: 0, spentUsdCycle: 5 }).level).toBe('unlimited');
  expect(inputKeyLimit({ ...base, monthlyLimitUsd: 10, spentUsdCycle: 8.5 })).toEqual({
    level: 'near',
    ratio: 0.85,
  });
  expect(inputKeyLimit({ ...base, monthlyLimitUsd: 10, spentUsdCycle: 12 })).toEqual({
    level: 'over',
    ratio: 1,
  });
  expect(
    inputKeyLimit({ ...base, monthlyLimitUsd: 10, spentUsdCycle: 2, limitReached: true }).level
  ).toBe('over');
});

test('settings form parsing and payload', () => {
  expect(parseCycleDay('15')).toBe(15);
  expect(['0', '32', '1.5', '', 'x'].map(parseCycleDay)).toEqual([null, null, null, null, null]);
  expect(parseLimitUsd('')).toBe(0);
  expect(parseLimitUsd('12.5')).toBe(12.5);
  expect(parseLimitUsd('-1')).toBeNull();
  expect(
    serializeInputKeySettings({
      authId: 'claude:apikey:0123456789ab',
      billingCycleDay: 15,
      monthlyLimitUsd: 0,
      clientKeysOnly: true,
      serveClientKeys: false,
      credentialGroups: [],
    })
  ).toEqual({
    auth_id: 'claude:apikey:0123456789ab',
    billing_cycle_day: 15,
    monthly_limit_usd: 0,
    client_keys_only: true,
    serve_client_keys: true,
    credential_groups: [],
  });
});

test('client key routing fields: create omits empty ones, update sends "" to clear', async () => {
  const calls: Array<{ url: string; data: unknown }> = [];
  const record = (async (url: string, data?: unknown) => {
    calls.push({ url, data });
    return { id: 'ck_1', name: 'app', credentials: 'subscription' };
  }) as typeof apiClient.post;
  apiClient.post = record;
  apiClient.patch = record as typeof apiClient.patch;
  const input = {
    name: 'app',
    project: '',
    models: [],
    credentials: 'api-key' as const,
    preferCredentials: 'subscription' as const,
    routeGroup: '',
    monthlyBudgetUsd: 0,
    expiresAt: '',
  };

  await clientKeysApi.create(input);
  expect(calls[0].data).toEqual({
    name: 'app',
    project: '',
    models: [],
    credentials: 'api-key',
    monthly_budget_usd: 0,
  });

  await clientKeysApi.update('ck_1', { ...input, credentials: 'any', routeGroup: 'commercial' });
  expect(calls[1].data).toMatchObject({
    credentials: 'any',
    prefer_credentials: 'subscription',
    route_group: 'commercial',
  });

  // Leaving `any` clears the preference; an empty group unpins.
  await clientKeysApi.update('ck_1', input);
  expect(calls[2].data).toMatchObject({ prefer_credentials: '', route_group: '' });

  expect(normalizeClientKey({ credentials: 'subscription' }).credentials).toBe('subscription');
  expect(
    normalizeClientKey({ credentials: 'any', prefer_credentials: 'api-key', route_group: 'x' })
  ).toMatchObject({ preferCredentials: 'api-key', routeGroup: 'x' });
});

test('groupChoices hides special* groups unless the key already holds one', () => {
  const configured = ['commercial', 'special', 'special-plus'];
  expect(groupChoices(configured, [])).toEqual(['commercial']);
  expect(groupChoices(configured, ['special-plus'])).toEqual(['commercial', 'special-plus']);
});
