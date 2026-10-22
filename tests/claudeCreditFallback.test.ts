import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { apiClient } from '@/services/api/client';
import { claudeCreditFallbackApi } from '@/services/api/claudeCreditFallback';
import { claudeCreditStatus, splitMinutes } from '@/features/quota/claudeCreditModel';

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));

const EXPIRES = '2026-10-22T18:40:00Z';
const EXPIRES_MS = Date.parse(EXPIRES);

describe('Claude credit fallback API', () => {
  test('reads and writes the switch without a path prefix and normalizes the payload', async () => {
    const payload = {
      configured: true,
      enabled: true,
      expires_at: EXPIRES,
      duration_seconds: 7200,
    };
    const get = spyOn(apiClient, 'get').mockResolvedValue(payload as never);
    const put = spyOn(apiClient, 'put').mockResolvedValue({
      ...payload,
      enabled: false,
      expires_at: null,
    } as never);
    spies.push(get, put);

    expect(await claudeCreditFallbackApi.get()).toEqual({
      configured: true,
      enabled: true,
      expiresAtMs: EXPIRES_MS,
      durationSeconds: 7200,
    });
    expect(get).toHaveBeenCalledWith('/claude-credit-fallback');

    expect(await claudeCreditFallbackApi.setEnabled(false)).toEqual({
      configured: true,
      enabled: false,
      expiresAtMs: null,
      durationSeconds: 7200,
    });
    expect(put).toHaveBeenCalledWith('/claude-credit-fallback', { enabled: false });
  });

  test('treats a malformed payload as not configured', async () => {
    spies.push(spyOn(apiClient, 'get').mockResolvedValue('<html>' as never));
    expect(await claudeCreditFallbackApi.get()).toEqual({
      configured: false,
      enabled: false,
      expiresAtMs: null,
      durationSeconds: 0,
    });
  });
});

describe('Claude credit status', () => {
  const on = { configured: true, enabled: true, expiresAtMs: EXPIRES_MS, durationSeconds: 7200 };

  test('counts down whole minutes to the expiry and floors at one minute', () => {
    const minute = 60_000;
    expect(claudeCreditStatus(on, EXPIRES_MS - 112 * minute - 30_000)).toEqual({
      on: true,
      untilMs: EXPIRES_MS,
      remainingMinutes: 112,
    });
    expect(claudeCreditStatus(on, EXPIRES_MS - 10_000)).toMatchObject({ remainingMinutes: 1 });
  });

  test('reads as off when disabled or past its expiry', () => {
    expect(claudeCreditStatus({ ...on, enabled: false }, EXPIRES_MS - 1)).toEqual({ on: false });
    expect(claudeCreditStatus(on, EXPIRES_MS)).toEqual({ on: false });
  });

  test('splits minutes into hours and minutes', () => {
    expect(splitMinutes(112)).toEqual({ hours: 1, minutes: 52 });
    expect(splitMinutes(120)).toEqual({ hours: 2, minutes: 0 });
    expect(splitMinutes(45)).toEqual({ hours: 0, minutes: 45 });
  });
});
