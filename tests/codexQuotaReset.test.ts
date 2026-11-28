import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { TFunction } from 'i18next';
import { CODEX_CONFIG } from '@/features/quota/providers/codex/data';
import { apiCallApi, authFilesApi, apiClient } from '@/services/api';
import {
  CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL,
  CODEX_RATE_LIMIT_RESET_CREDITS_URL,
} from '@/utils/quota';

const t = ((key: string) => key) as TFunction;
const file = { name: 'codex-test.json', auth_index: 'test-index', type: 'codex' };
const response = (body: unknown, statusCode = 200) => ({
  statusCode,
  body,
  bodyText: JSON.stringify(body),
  header: {},
});
const credit = (id: string, expiresAt: string) => ({
  id,
  reset_type: 'codex_rate_limits',
  status: 'available',
  expires_at: expiresAt,
});
const creditList = {
  available_count: 3,
  credits: [
    credit('later', '2999-02-01T00:00:00Z'),
    credit('first', '2999-01-01T00:00:00Z'),
    credit('expired', '2000-01-01T00:00:00Z'),
  ],
};
const reset = () => CODEX_CONFIG.resetQuota!(file, t);
const mocks: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore();
});

function setup(body: unknown, statusCode = 200) {
  const calls: string[] = [];
  const request = spyOn(apiCallApi, 'request').mockImplementation(async (payload) => {
    if (payload.url === CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL) {
      calls.push('consume');
      return response(body, statusCode);
    }
    if (payload.url === CODEX_RATE_LIMIT_RESET_CREDITS_URL && !calls.includes('consume')) {
      calls.push('list');
      return response(creditList);
    }
    calls.push('read');
    return response({});
  });
  const clear = spyOn(authFilesApi, 'resetCooldown').mockImplementation(async () => {
    calls.push('clear');
    return { status: 'ok', auth_index: 'test-index', models: [] };
  });
  mocks.push(request, clear);
  return { calls, request, clear };
}

describe('Codex reset gateway cooldown', () => {
  test.each(['reset', 'already_redeemed'])(
    'clears only after confirmed %s, before reads',
    async (code) => {
      const { calls, clear } = setup({ code, windows_reset: 0 });
      await reset();
      expect(calls.slice(0, 4)).toEqual(['list', 'consume', 'clear', 'read']);
      expect(clear).toHaveBeenCalledTimes(1);
      expect(clear).toHaveBeenCalledWith('test-index');
    }
  );

  test.each(['no_credit', 'nothing_to_reset', 'unknown'])('does not clear for %s', async (code) => {
    const { calls } = setup({ code });
    await expect(reset()).rejects.toThrow('codex_quota.reset_not_confirmed');
    expect(calls).toEqual(['list', 'consume']);
  });

  test('redeems the earliest-expiring unexpired credit', async () => {
    const { request } = setup({ code: 'reset' });
    await reset();
    const consume = request.mock.calls.find(
      ([payload]) => payload.url === CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL
    );
    expect(JSON.parse(String(consume?.[0].data)).credit_id).toBe('first');
  });

  test('does not consume without an available credit', async () => {
    const { calls, request } = setup({ code: 'reset' });
    request.mockImplementation(async (payload) => {
      calls.push(payload.url === CODEX_RATE_LIMIT_RESET_CREDITS_URL ? 'list' : 'consume');
      return response({ available_count: 0, credits: [] });
    });
    await expect(reset()).rejects.toThrow('codex_quota.reset_not_confirmed');
    expect(calls).toEqual(['list']);
  });

  test('does not clear on HTTP failure', async () => {
    const { calls } = setup({ code: 'reset' }, 503);
    await expect(reset()).rejects.toThrow();
    expect(calls).toEqual(['list', 'consume']);
  });

  test('does not clear on transport failure', async () => {
    const { request, clear } = setup({});
    request.mockRejectedValue(new Error('timeout'));
    await expect(reset()).rejects.toThrow('timeout');
    expect(clear).not.toHaveBeenCalled();
  });

  test('directs cooldown failures to manual clearing, without another consume', async () => {
    const { request, clear } = setup({ code: 'reset' });
    clear.mockRejectedValue(new Error('offline'));
    await expect(reset()).rejects.toThrow('codex_quota.reset_cooldown_failed');
    expect(request).toHaveBeenCalledTimes(2);
  });

  test('rejects mismatched cooldown acknowledgements', async () => {
    const { clear } = setup({ code: 'reset' });
    clear.mockResolvedValue({ status: 'ok', auth_index: 'other-index', models: [] });
    await expect(reset()).rejects.toThrow('codex_quota.reset_cooldown_failed');
  });

  test('does not clear after connection changes during redemption', async () => {
    const { clear } = setup({ code: 'reset' });
    const revision = spyOn(apiClient, 'getConnectionRevision')
      .mockReturnValueOnce(1)
      .mockReturnValue(2);
    mocks.push(revision);
    await expect(reset()).rejects.toThrow('codex_quota.reset_cooldown_failed');
    expect(clear).not.toHaveBeenCalled();
  });
});
