import { describe, expect, test } from 'bun:test';
import { normalizeAuthFilesResponse } from '../src/services/api/authFiles';
import type { AuthFilesResponse } from '../src/types/authFile';

const responseWithRawFiles = (files: Array<Record<string, unknown>>): AuthFilesResponse =>
  ({ files }) as unknown as AuthFilesResponse;

describe('auth-files response normalization', () => {
  test('reads the Fable lock only when the gateway sets it', () => {
    const result = normalizeAuthFilesResponse(
      responseWithRawFiles([
        { name: 'a.json', fable_locked: true },
        { name: 'b.json', fable_locked: false },
      ])
    );

    expect(result.files.map((file) => file.fableLocked)).toEqual([true, undefined]);
  });

  test('accepts only HTTPS Google Accounts verification links for Antigravity', () => {
    const url = 'https://accounts.google.com/signin?continue=%2Fsetup';
    const { files } = normalizeAuthFilesResponse(
      responseWithRawFiles(
        [
          url,
          undefined,
          '//accounts.google.com/signin',
          'http://accounts.google.com/signin',
          'https://accounts.google.com.example.org/signin',
          'https://accounts.google.com@example.org/signin',
          'https://accounts.google.com:8443/signin',
          'blob:https://accounts.google.com/id',
          url,
        ].map((verificationUrl, index) => ({
          name: `account-${index}.json`,
          provider: index === 8 ? 'codex' : 'antigravity',
          status: 'verification_required',
          verification_url: verificationUrl,
        }))
      )
    );

    expect(files.map((file) => file.verificationUrl)).toEqual([
      url,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  test('normalizes WRR weights while preserving zero and negative values', () => {
    const result = normalizeAuthFilesResponse(
      responseWithRawFiles([
        { name: 'positive.json', weight: 5 },
        { name: 'string.json', weight: '7' },
        { name: 'zero.json', weight: 0 },
        { name: 'negative.json', weight: -2 },
      ])
    );

    expect(result.files.map((file) => file.weight)).toEqual([-2, 5, 7, 0]);
  });

  test('omits missing, fractional, and unsafe WRR weights from the normalized field', () => {
    const result = normalizeAuthFilesResponse(
      responseWithRawFiles([
        { name: 'missing.json' },
        { name: 'fractional.json', weight: '1.5' },
        { name: 'unsafe.json', weight: Number.MAX_SAFE_INTEGER + 1 },
      ])
    );

    expect(result.files.map((file) => file.weight)).toEqual([undefined, undefined, undefined]);
  });

  test('applies the same safe-integer normalization to priority', () => {
    const result = normalizeAuthFilesResponse(
      responseWithRawFiles([
        { name: 'valid.json', priority: '-3' },
        { name: 'invalid.json', priority: '3.5' },
      ])
    );

    expect(result.files.map((file) => file.priority)).toEqual([undefined, -3]);
  });

  test('surfaces the trimmed account email', () => {
    const result = normalizeAuthFilesResponse(
      responseWithRawFiles([{ name: 'codex-a.json', email: '  user@example.com  ' }])
    );

    expect(result.files[0]?.email).toBe('user@example.com');
  });

  test('leaves an empty backend email as the raw empty string', () => {
    const result = normalizeAuthFilesResponse(
      responseWithRawFiles([{ name: 'kimi-1.json', email: '' }])
    );

    expect(result.files[0]?.email).toBe('');
  });

  test('normalizes project_id to projectId while keeping the raw key', () => {
    const result = normalizeAuthFilesResponse(
      responseWithRawFiles([{ name: 'vertex-a.json', project_id: ' my-proj ' }])
    );

    expect(result.files[0]?.projectId).toBe('my-proj');
    expect(result.files[0]?.project_id).toBe(' my-proj ');
  });

  test('recovers a non-empty email from the lower-priority duplicate entry', () => {
    const result = normalizeAuthFilesResponse(
      responseWithRawFiles([
        { name: 'codex-a.json', source: 'file', path: '/auths/codex-a.json', email: '' },
        { name: 'codex-a.json', source: 'memory', email: 'user@example.com' },
      ])
    );

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.email).toBe('user@example.com');
  });

  test('prefers the higher-scored entry when both emails are non-empty and differ', () => {
    const result = normalizeAuthFilesResponse(
      responseWithRawFiles([
        { name: 'codex-a.json', source: 'memory', email: 'stale@example.com' },
        {
          name: 'codex-a.json',
          source: 'file',
          path: '/auths/codex-a.json',
          email: 'fresh@example.com',
        },
      ])
    );

    expect(result.files[0]?.email).toBe('fresh@example.com');
  });

  test('passes account through raw without deriving a camelCase field', () => {
    const result = normalizeAuthFilesResponse(
      responseWithRawFiles([
        { name: 'gemini-apikey.json', account: 'sk-live-abcd', account_type: 'api_key' },
      ])
    );

    expect(result.files[0]?.account).toBe('sk-live-abcd');
    expect(result.files[0]?.accountType).toBeUndefined();
  });
});
