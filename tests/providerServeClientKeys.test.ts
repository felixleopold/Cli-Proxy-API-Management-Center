import { afterEach, expect, test } from 'bun:test';
import { apiClient } from '../src/services/api/client';
import { providersApi } from '../src/services/api/providers';
import { normalizeProviderGroups } from '../src/services/api/transformers';
import type { ProviderKeyConfig } from '../src/types';

const originalGet = apiClient.get;
const originalPut = apiClient.put;

afterEach(() => {
  apiClient.get = originalGet;
  apiClient.put = originalPut;
});

const stubConfig = (apiKeys: unknown) => {
  const writes: Array<{ url: string; data: unknown }> = [];
  apiClient.get = (async () => ({ 'api-keys': apiKeys })) as typeof apiClient.get;
  apiClient.put = (async (url: string, data?: unknown) => {
    writes.push({ url, data });
    return undefined;
  }) as typeof apiClient.put;
  return writes;
};

test('toggles serve-client-keys on a direct key without dropping other fields', async () => {
  const writes = stubConfig({
    claude: [
      {
        name: 'claude-1',
        keys: [{ 'api-key': 'sk-a', priority: 3, 'future-field': 'keep' }],
      },
    ],
  });
  await providersApi.updateClaudeConfig('sk-a', undefined, {
    apiKey: 'sk-a',
    priority: 3,
    serveClientKeys: true,
  });
  expect(writes[0]).toEqual({
    url: '/config/api-keys/claude',
    data: [
      {
        name: 'claude-1',
        keys: [
          { 'api-key': 'sk-a', priority: 3, 'future-field': 'keep', 'serve-client-keys': true },
        ],
      },
    ],
  });

  const off = stubConfig({
    claude: [
      { name: 'claude-1', keys: [{ 'api-key': 'sk-a', priority: 3, 'serve-client-keys': true }] },
    ],
  });
  const [{ serveClientKeys }] = normalizeProviderGroups(
    (await apiClient.get<{ 'api-keys': { claude: unknown } }>('/config'))['api-keys'].claude
  ) as ProviderKeyConfig[];
  expect(serveClientKeys).toBe(true);
  await providersApi.updateClaudeConfig('sk-a', undefined, {
    apiKey: 'sk-a',
    priority: 3,
    serveClientKeys: false,
  });
  expect(off[0].data).toEqual([{ name: 'claude-1', keys: [{ 'api-key': 'sk-a', priority: 3 }] }]);
});

test('round-trips serve-client-keys on the OpenAI-compatible provider entry', async () => {
  const writes = stubConfig({
    'openai-compatibility': [
      {
        name: 'example',
        'base-url': 'https://example.com/v1',
        priority: 2,
        keys: [{ 'api-key': 'key-a', weight: 2 }, { 'api-key': 'key-b' }],
      },
    ],
  });
  const [current] = await providersApi.getOpenAIProviders();
  await providersApi.updateOpenAIProvider('example', 0, { ...current, serveClientKeys: true });
  expect(writes[0].data).toEqual([
    {
      name: 'example',
      'base-url': 'https://example.com/v1',
      priority: 2,
      'serve-client-keys': true,
      keys: [{ 'api-key': 'key-a', weight: 2 }, { 'api-key': 'key-b' }],
    },
  ]);

  const off = stubConfig({
    'openai-compatibility': [
      {
        name: 'example',
        'base-url': 'https://example.com/v1',
        'serve-client-keys': true,
        keys: [{ 'api-key': 'key-a' }],
      },
    ],
  });
  const [enabled] = await providersApi.getOpenAIProviders();
  expect(enabled.serveClientKeys).toBe(true);
  await providersApi.updateOpenAIProvider('example', 0, { ...enabled, serveClientKeys: false });
  expect(off[0].data).toEqual([
    { name: 'example', 'base-url': 'https://example.com/v1', keys: [{ 'api-key': 'key-a' }] },
  ]);
});
