// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `$t(key)` references in ui.json (site title, PWA name) resolve against the merged
 * locale data on the server: the PWA manifest and the sign-in screen follow
 * `product.name` in the reader's language.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports.
 */
import { jest } from '@jest/globals';

const locales = {
  en: { product: { name: 'Acme AI' }, footer: { copyright: '© $t(product.name)' } },
  de: { product: { name: 'Acme KI' } },
  fr: {}
};

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => ({ defaultLanguage: 'en' }),
    getLocalizations: lang => ({ data: locales[lang] ?? null })
  }
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { resolveUiText, resolveUiRefs, pickRequestLanguage } =
  await import('../utils/uiTextRefs.js');
const { resolvePwaConfig, localizePwaConfig, buildManifest, computePwaETag } =
  await import('../services/pwa/PwaService.js');

describe('resolveUiText', () => {
  it('resolves a reference per language', () => {
    const title = { en: '$t(product.name)', de: '$t(product.name)' };
    expect(resolveUiText(title, 'en')).toBe('Acme AI');
    expect(resolveUiText(title, 'de')).toBe('Acme KI');
  });

  it('falls back to the default language when a language has no text', () => {
    expect(resolveUiText('$t(product.name)', 'fr')).toBe('Acme AI');
  });

  it('resolves references inside referenced texts', () => {
    expect(resolveUiRefs('$t(footer.copyright)', 'en')).toBe('© Acme AI');
  });

  it('never shows the key: a missing translation becomes the fallback', () => {
    expect(resolveUiText('$t(nope.missing)', 'en', 'iHub Apps')).toBe('iHub Apps');
  });

  it('keeps literal text as it is', () => {
    expect(resolveUiText({ en: 'My Hub' }, 'en', 'x')).toBe('My Hub');
  });

  it('reads the primary language of Accept-Language', () => {
    expect(pickRequestLanguage({ headers: { 'accept-language': 'de-DE,de;q=0.9' } })).toBe('de');
    expect(pickRequestLanguage({ headers: {} })).toBe('en');
  });
});

describe('PWA manifest follows the product name', () => {
  const raw = { enabled: true, name: '$t(product.name)', shortName: 'Acme' };

  it('names the app in the reader language', () => {
    const de = buildManifest(localizePwaConfig(resolvePwaConfig(raw), 'de'));
    const en = buildManifest(localizePwaConfig(resolvePwaConfig(raw), 'en'));
    expect(de.name).toBe('Acme KI');
    expect(en.name).toBe('Acme AI');
    expect(de.short_name).toBe('Acme');
  });

  it('defaults to the product name when the config has no name', () => {
    const manifest = buildManifest(localizePwaConfig(resolvePwaConfig({ enabled: true }), 'de'));
    expect(manifest.name).toBe('Acme KI');
  });

  it('applies the length limits to the resolved text and changes the ETag with it', () => {
    const long = localizePwaConfig(
      resolvePwaConfig({ name: 'x'.repeat(80), shortName: 'y'.repeat(20) })
    );
    expect(long.name).toHaveLength(60);
    expect(long.shortName).toHaveLength(15);
    const de = computePwaETag(localizePwaConfig(resolvePwaConfig(raw), 'de'));
    const en = computePwaETag(localizePwaConfig(resolvePwaConfig(raw), 'en'));
    expect(de).not.toBe(en);
  });
});
