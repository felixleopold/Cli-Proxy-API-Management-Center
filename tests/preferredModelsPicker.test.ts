import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@/i18n';
import { ExcludedModelsPicker } from '@/components/excludedModels';

const translations = i18n.cloneInstance({ lng: 'en' });
const render = (i18nPrefix: 'excluded_models' | 'preferred_models') =>
  renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n: translations },
      createElement(ExcludedModelsPicker, {
        value: ['gpt-5-*'],
        onChange: () => {},
        candidates: [{ id: 'gpt-5-mini' }, { id: 'claude-opus' }],
        i18nPrefix,
      })
    )
  );

describe('preferred models picker', () => {
  test('is exact-only: no wildcard editor and a glob never counts as preferred', () => {
    const preferred = render('preferred_models');
    expect(preferred).not.toContain('<textarea');
    expect(preferred).toContain('No preferred models');

    const excluded = render('excluded_models');
    expect(excluded).toContain('<textarea');
    expect(excluded).toContain('1 excluded');
  });
});
