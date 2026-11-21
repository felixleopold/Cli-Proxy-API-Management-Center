import { afterEach, expect, test } from 'bun:test';
import { apiClient } from '../src/services/api/client';
import { providersApi } from '../src/services/api/providers';
import { normalizeConfigResponse, normalizeProviderGroups } from '../src/services/api/transformers';
import type { ProviderKeyConfig } from '../src/types';

const originalGet = apiClient.get;
const originalPut = apiClient.put;
afterEach(() => {
  apiClient.get = originalGet;
  apiClient.put = originalPut;
});

const stub = (apiKeys: unknown) => {
  const writes: unknown[] = [];
  apiClient.get = (async () => ({ 'api-keys': apiKeys })) as typeof apiClient.get;
  apiClient.put = (async (_url: string, data?: unknown) => {
    writes.push(data);
  }) as typeof apiClient.put;
  return writes;
};

const routing = {
  'client-keys-only': true,
  'credential-groups': ['commercial'],
  'billing-cycle-day': 15,
  'monthly-limit-usd': 10,
};

test('reads client-key routing and spend fields and keeps them through an edit', async () => {
  const group = { name: 'claude-2', ...routing, keys: [{ 'api-key': 'sk-a', priority: 1 }] };
  const writes = stub({ claude: [group] });
  const [row] = normalizeProviderGroups([group]) as ProviderKeyConfig[];
  expect(row).toMatchObject({
    clientKeysOnly: true,
    credentialGroups: ['commercial'],
    billingCycleDay: 15,
    monthlyLimitUsd: 10,
  });

  await providersApi.updateClaudeConfig('sk-a', undefined, { ...row, priority: 2 });
  // Inherited from the group, untouched on the key.
  expect(writes[0]).toEqual([{ ...group, keys: [{ 'api-key': 'sk-a', priority: 2 }] }]);
});

test('an emptied credential-groups list overrides the inherited one', async () => {
  const group = { name: 'claude-2', ...routing, keys: [{ 'api-key': 'sk-a' }] };
  const writes = stub({ claude: [group] });
  const [row] = normalizeProviderGroups([group]) as ProviderKeyConfig[];
  await providersApi.updateClaudeConfig('sk-a', undefined, { ...row, credentialGroups: [] });
  expect(writes[0]).toEqual([{ ...group, keys: [{ 'api-key': 'sk-a', 'credential-groups': [] }] }]);
});

test('config lists credential-group names', () => {
  const config = normalizeConfigResponse({
    'credential-groups': [{ name: 'commercial', credentials: [] }, { name: ' eu ' }, {}],
  });
  expect(config.credentialGroups).toEqual(['commercial', 'eu']);
});
