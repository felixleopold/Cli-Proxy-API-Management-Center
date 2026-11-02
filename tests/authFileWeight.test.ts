import { describe, expect, test } from 'bun:test';
import {
  buildAuthFileFieldsPatch,
  type PrefixProxyEditorState,
} from '../src/features/authFiles/hooks/useAuthFilesPrefixProxyEditor';
import { readAuthFileDisableCooling } from '../src/features/authFiles/constants';

const makeEditor = (json: Record<string, unknown>, weight: string): PrefixProxyEditorState => ({
  fileName: 'credential.json',
  fileInfoText: '',
  loading: false,
  saving: false,
  error: null,
  originalText: JSON.stringify(json),
  rawText: JSON.stringify(json),
  invalidContentPreview: '',
  json,
  providerKey: 'codex',
  prefix: '',
  proxyUrl: '',
  priority: '',
  weight,
  weightError: null,
  usageCapPercent: '',
  usageCapPercentError: null,
  planMultiplier: '',
  planMultiplierError: null,
  plan: '',
  lender: '',
  reserveFiveHour: '',
  reserveFiveHourError: null,
  reserveWeekly: '',
  reserveWeeklyError: null,
  disableCooling: false,
  disableCoolingTouched: false,
  websockets: false,
  websocketsTouched: false,
  usingApi: false,
  usingApiTouched: false,
  note: '',
  noteTouched: false,
  excludedModelsText: '',
  excludedModelsTouched: false,
  headersText: '',
  headersTouched: false,
  headersError: null,
});

const resolveError = (key: string) => key;

describe('auth-file credential weight patch', () => {
  test('writes numeric weight and uses null to restore the default', () => {
    expect(buildAuthFileFieldsPatch(makeEditor({}, '0'), resolveError)).toEqual({ weight: 0 });
    expect(buildAuthFileFieldsPatch(makeEditor({ weight: 5 }, ''), resolveError)).toEqual({
      weight: null,
    });
  });

  test('recognizes a numeric string in an existing auth file', () => {
    expect(buildAuthFileFieldsPatch(makeEditor({ weight: '7' }, '7'), resolveError)).toEqual({});
    expect(buildAuthFileFieldsPatch(makeEditor({ weight: '7' }, ''), resolveError)).toEqual({
      weight: null,
    });
  });

  test('rejects invalid and oversized values before PATCH', () => {
    expect(() => buildAuthFileFieldsPatch(makeEditor({}, '1.5'), resolveError)).toThrow(
      'auth_files.weight_invalid_integer'
    );
    expect(() => buildAuthFileFieldsPatch(makeEditor({}, '1000001'), resolveError)).toThrow(
      'auth_files.weight_invalid_max'
    );
  });
});

describe('auth-file usage cap patch', () => {
  const withCap = (
    json: Record<string, unknown>,
    usageCapPercent: string,
    providerKey = 'codex'
  ) => ({
    ...makeEditor(json, ''),
    providerKey,
    usageCapPercent,
  });

  test('sets, keeps, and clears the cap with null', () => {
    expect(buildAuthFileFieldsPatch(withCap({}, '80'), resolveError)).toEqual({
      usage_cap_percent: 80,
    });
    expect(
      buildAuthFileFieldsPatch(withCap({ usage_cap_percent: 80 }, '80'), resolveError)
    ).toEqual({});
    expect(buildAuthFileFieldsPatch(withCap({ usage_cap_percent: 80 }, ''), resolveError)).toEqual({
      usage_cap_percent: null,
    });
    expect(
      buildAuthFileFieldsPatch(withCap({ usage_cap_percent: null }, ''), resolveError)
    ).toEqual({});
  });

  test('keeps or clears a fractional cap the gateway already enforces', () => {
    expect(
      buildAuthFileFieldsPatch(withCap({ usage_cap_percent: 80.5 }, '80.5'), resolveError)
    ).toEqual({});
    expect(
      buildAuthFileFieldsPatch(withCap({ usage_cap_percent: 80.5 }, ''), resolveError)
    ).toEqual({ usage_cap_percent: null });
  });

  test('rejects out-of-range input and ignores providers without observed windows', () => {
    for (const value of ['0', '100', '50.5', 'abc']) {
      expect(() => buildAuthFileFieldsPatch(withCap({}, value), resolveError)).toThrow(
        'auth_files.usage_cap_invalid'
      );
    }
    expect(buildAuthFileFieldsPatch(withCap({}, '80', 'antigravity'), resolveError)).toEqual({});
  });
});

describe('auth-file usage reserve patch', () => {
  const claude = (json: Record<string, unknown>, fields: Partial<PrefixProxyEditorState>) => ({
    ...makeEditor(json, ''),
    providerKey: 'claude',
    plan: 'max',
    lender: 'Ferdinand',
    reserveFiveHour: '0',
    reserveWeekly: '25',
    ...fields,
  });
  const existing = {
    plan: 'Max 5x',
    lender: 'Ferdinand',
    reserve_five_hour_percent: 0,
    reserve_weekly_percent: 25,
  };

  test('keeps untouched values, including a plan alias the gateway reads as max', () => {
    expect(buildAuthFileFieldsPatch(claude(existing, {}), resolveError)).toEqual({});
  });

  test('writes changes and clears empty fields with null', () => {
    expect(
      buildAuthFileFieldsPatch(
        claude(existing, { plan: 'ultra', lender: '', reserveFiveHour: '', reserveWeekly: '12.5' }),
        resolveError
      )
    ).toEqual({
      plan: 'ultra',
      lender: null,
      reserve_five_hour_percent: null,
      reserve_weekly_percent: 12.5,
    });
  });

  test('rejects a reserve outside 0..100 and leaves the plan of other providers alone', () => {
    expect(() =>
      buildAuthFileFieldsPatch(claude(existing, { reserveWeekly: '101' }), resolveError)
    ).toThrow('auth_files.reserve_invalid');
    expect(
      buildAuthFileFieldsPatch(
        claude({ ...existing, plan: 'plus' }, { providerKey: 'codex', plan: '' }),
        resolveError
      )
    ).toEqual({});
  });
});

describe('auth-file disable cooling patch', () => {
  test('reads canonical and legacy boolean-compatible metadata', () => {
    expect(readAuthFileDisableCooling({ disable_cooling: 'true' })).toBe(true);
    expect(readAuthFileDisableCooling({ 'disable-cooling': 1 })).toBe(true);
    expect(
      readAuthFileDisableCooling({ disable_cooling: 'invalid', 'disable-cooling': true })
    ).toBe(true);
    expect(readAuthFileDisableCooling({ disable_cooling: false, 'disable-cooling': true })).toBe(
      false
    );
  });

  test('writes the canonical field when enabling the per-credential override', () => {
    const editor = {
      ...makeEditor({}, ''),
      disableCooling: true,
      disableCoolingTouched: true,
    };

    expect(buildAuthFileFieldsPatch(editor, resolveError)).toEqual({ disable_cooling: true });
  });

  test('preserves the legacy field name and writes false when disabling it', () => {
    const editor = {
      ...makeEditor({ 'disable-cooling': true }, ''),
      disableCooling: false,
      disableCoolingTouched: true,
    };

    expect(buildAuthFileFieldsPatch(editor, resolveError)).toEqual({ 'disable-cooling': false });
  });

  test('does not patch an untouched or unchanged override', () => {
    expect(
      buildAuthFileFieldsPatch(makeEditor({ disable_cooling: true }, ''), resolveError)
    ).toEqual({});
    expect(
      buildAuthFileFieldsPatch(
        {
          ...makeEditor({ disable_cooling: 'true' }, ''),
          disableCooling: true,
          disableCoolingTouched: true,
        },
        resolveError
      )
    ).toEqual({});
  });
});

describe('auth-file excluded models patch', () => {
  test('writes normalized model patterns to the canonical field', () => {
    const editor = {
      ...makeEditor({}, ''),
      excludedModelsText: ' gpt-5-*\nGPT-5-*\nclaude-opus ',
      excludedModelsTouched: true,
    };

    expect(buildAuthFileFieldsPatch(editor, resolveError)).toEqual({
      excluded_models: ['gpt-5-*', 'claude-opus'],
    });
  });

  test('preserves the legacy hyphenated field name', () => {
    const editor = {
      ...makeEditor({ 'excluded-models': ['old-model'] }, ''),
      excludedModelsText: 'new-model',
      excludedModelsTouched: true,
    };

    expect(buildAuthFileFieldsPatch(editor, resolveError)).toEqual({
      'excluded-models': ['new-model'],
    });
  });

  test('clears exclusions with an empty array and ignores untouched values', () => {
    const original = { excluded_models: ['gpt-5-*'] };
    expect(buildAuthFileFieldsPatch(makeEditor(original, ''), resolveError)).toEqual({});
    expect(
      buildAuthFileFieldsPatch(
        {
          ...makeEditor(original, ''),
          excludedModelsText: '',
          excludedModelsTouched: true,
        },
        resolveError
      )
    ).toEqual({ excluded_models: [] });
  });
});
