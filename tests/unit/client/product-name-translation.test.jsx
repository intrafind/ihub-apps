// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The product name has one translation key, `product.name`. Every other text
 * that mentions the product refers to it with `$t(product.name)`, so an admin
 * who overrides that one key (contents/locales/{lang}.json) renames the product
 * everywhere. The header tagline works the same way through `product.tagline`.
 */
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';
import ui from '../../../server/defaults/config/ui.json';
import { resolveTranslationRefs } from '../../../client/src/utils/translationRefs';

const LOCALES = { en, de };

function leaves(node, prefix = []) {
  if (node === null || typeof node !== 'object') return [{ key: prefix.join('.'), value: node }];
  return Object.entries(node).flatMap(([k, v]) => leaves(v, [...prefix, k]));
}

function valueAt(node, key) {
  return key.split('.').reduce((current, part) => current?.[part], node);
}

describe.each(Object.entries(LOCALES))('built-in %s translations', (lang, locale) => {
  const strings = leaves(locale).filter(({ value }) => typeof value === 'string');

  it('define the product name and tagline', () => {
    expect(typeof locale.product.name).toBe('string');
    expect(locale.product.name.length).toBeGreaterThan(0);
    expect(typeof locale.product.tagline).toBe('string');
  });

  it('spell the product name out only in product.name', () => {
    const offenders = strings
      .filter(({ key }) => key !== 'product.name')
      .filter(({ value }) => value.includes(locale.product.name))
      .map(({ key }) => key);
    expect(offenders).toEqual([]);
  });

  it('refer only to keys that exist', () => {
    const missing = strings.flatMap(({ key, value }) =>
      [...value.matchAll(/\$t\(([^()\s]+)\)/g)]
        .filter(([, ref]) => typeof valueAt(locale, ref) !== 'string')
        .map(([, ref]) => `${key} -> ${ref}`)
    );
    expect(missing).toEqual([]);
  });
});

describe('overriding product.name', () => {
  async function translatorWith(productName) {
    const instance = i18next.createInstance();
    await instance.init({
      lng: 'en',
      resources: {
        en: { translation: { ...en, product: { ...en.product, name: productName } } }
      },
      interpolation: { escapeValue: false }
    });
    return instance;
  }

  it('changes every text that refers to it', async () => {
    const t = (await translatorWith('Acme Hub')).t;
    expect(t('footer.copyright', { year: 2026 })).toBe('© 2026 Acme Hub');
    expect(t('app.title')).toBe('Acme Hub');
    expect(t('pages.home.title')).toBe('Acme Hub');
    expect(t('chatSharing.viewer.openApp')).toBe('Open Acme Hub');
  });

  it('keeps the built-in name without an override', async () => {
    const t = (await translatorWith(en.product.name)).t;
    expect(t('app.title')).toBe('iHub Apps');
  });
});

describe('resolveTranslationRefs', () => {
  const t = (key, options) =>
    ({ 'product.tagline': 'by Acme' })[key] ?? options?.defaultValue ?? key;

  it('replaces a reference with the translation', () => {
    expect(resolveTranslationRefs('$t(product.tagline)', t)).toBe('by Acme');
    expect(resolveTranslationRefs('Hi, $t(product.tagline)!', t)).toBe('Hi, by Acme!');
  });

  it('leaves plain text, an empty string and non-strings alone', () => {
    expect(resolveTranslationRefs('by IntraFind', t)).toBe('by IntraFind');
    expect(resolveTranslationRefs('', t)).toBe('');
    expect(resolveTranslationRefs(undefined, t)).toBeUndefined();
  });

  it('passes the values for the placeholders of the referenced text', () => {
    const withYear = (key, options) =>
      key === 'footer.legal' ? `© ${options.year} Acme` : options.defaultValue;
    expect(resolveTranslationRefs('$t(footer.legal)', withYear, { year: 2026 })).toBe(
      '© 2026 Acme'
    );
  });

  it('turns a reference to a missing key into an empty string', () => {
    expect(resolveTranslationRefs('$t(no.such.key)', t)).toBe('');
  });
});

describe('shipped ui.json', () => {
  const shipped = ['header.tagline', 'footer.text'].map(path => ({
    path,
    value: path.split('.').reduce((node, part) => node[part], ui)
  }));

  it.each(shipped)('refers to translations that exist: $path', ({ value }) => {
    for (const [language, text] of Object.entries(value)) {
      const locale = LOCALES[language];
      const refs = [...text.matchAll(/\$t\(([^()\s]+)\)/g)].map(match => match[1]);
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) expect(typeof valueAt(locale, ref)).toBe('string');
    }
  });

  it('shows the year in the footer text', async () => {
    const instance = i18next.createInstance();
    await instance.init({
      lng: 'en',
      resources: { en: { translation: en } },
      interpolation: { escapeValue: false }
    });
    const resolved = resolveTranslationRefs(ui.footer.text.en, instance.t.bind(instance), {
      year: 2031
    });
    expect(resolved).toBe('© 2031 IntraFind Software AG. All rights reserved.');
  });
});
