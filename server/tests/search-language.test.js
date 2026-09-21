#!/usr/bin/env node

/**
 * Search-language resolution specs.
 *
 * The rule these pin down is the one every provider now shares: a search runs
 * in **the user's language**, and only when the caller had none to give does it
 * fall back to the install's `platform.defaultLanguage` — never to a language
 * hard-coded in a provider.
 *
 * That mattered because the old behaviour was invisible: a German install whose
 * users asked German questions could still be served US-market results from a
 * workflow run, with no setting anywhere that changed it.
 *
 * Run: node --test server/tests/search-language.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FALLBACK_SEARCH_LANGUAGE,
  resolveSearchLanguage
} from '../services/search/searchLanguage.js';
import { resolveStaanMarket } from '../services/search/staanProvider.js';
import { resolveQwantLocale } from '../services/search/qwantProvider.js';
import { resolveBraveSearchParams } from '../services/WebSearchService.js';

/** An install whose configured default language is `lang`. */
const install = lang => ({ defaultLanguage: () => lang });

describe('resolveSearchLanguage', () => {
  it("uses the user's language whenever there is one", () => {
    assert.equal(resolveSearchLanguage('de', install('en')), 'de');
    assert.equal(resolveSearchLanguage('en-GB', install('de')), 'en-GB');
  });

  it("falls back to the install's configured language, not to English", () => {
    assert.equal(resolveSearchLanguage(undefined, install('de')), 'de');
    assert.equal(resolveSearchLanguage('', install('de')), 'de');
    assert.equal(resolveSearchLanguage('   ', install('de')), 'de');
    assert.equal(resolveSearchLanguage(null, install('fr')), 'fr');
  });

  it('ignores a non-string language', () => {
    assert.equal(resolveSearchLanguage(42, install('de')), 'de');
    assert.equal(resolveSearchLanguage({}, install('de')), 'de');
  });

  it('trims surrounding whitespace off both sources', () => {
    assert.equal(resolveSearchLanguage('  de  ', install('en')), 'de');
    assert.equal(resolveSearchLanguage(undefined, install('  de  ')), 'de');
  });

  it('never returns an empty language, even from a broken config', () => {
    for (const broken of ['', '   ', undefined, null, 42]) {
      assert.equal(resolveSearchLanguage(undefined, install(broken)), FALLBACK_SEARCH_LANGUAGE);
    }
  });

  it('survives a config read that throws', () => {
    const exploding = {
      defaultLanguage: () => {
        throw new Error('config cache not ready');
      }
    };
    // A search is not worth failing over a config read.
    assert.throws(() => resolveSearchLanguage(undefined, exploding));
    // …but the user's own language never reaches the config at all.
    assert.equal(resolveSearchLanguage('de', exploding), 'de');
  });
});

describe('the configured default reaches every provider', () => {
  // The composition each provider performs: resolve the language first, then
  // map it onto that API's own locale/market/params.
  const german = install('de');

  it('Staan maps a German install onto the German market', () => {
    assert.equal(resolveStaanMarket(resolveSearchLanguage(undefined, german)), 'de-de');
  });

  it('Qwant maps a German install onto the German locale', () => {
    assert.equal(resolveQwantLocale(resolveSearchLanguage(undefined, german)), 'de_DE');
  });

  it('Brave maps a German install onto German content', () => {
    assert.deepEqual(resolveBraveSearchParams(resolveSearchLanguage(undefined, german)), {
      search_lang: 'de'
    });
  });

  it("the user's language still wins over the install default everywhere", () => {
    const lang = resolveSearchLanguage('en-GB', german);
    assert.equal(resolveStaanMarket(lang), 'en-gb');
    assert.equal(resolveQwantLocale(lang), 'en_GB');
    assert.deepEqual(resolveBraveSearchParams(lang), { search_lang: 'en-gb', country: 'GB' });
  });
});

describe('resolveBraveSearchParams', () => {
  it('sends the language as ISO 639-1, matching Brave’s own example', () => {
    // Brave documents `country=DE&search_lang=de`.
    assert.deepEqual(resolveBraveSearchParams('de-DE'), { search_lang: 'de', country: 'DE' });
  });

  it('sends the language alone for a bare tag', () => {
    assert.deepEqual(resolveBraveSearchParams('de'), { search_lang: 'de' });
    assert.deepEqual(resolveBraveSearchParams('en'), { search_lang: 'en' });
  });

  it('accepts underscore and mixed-case forms', () => {
    assert.deepEqual(resolveBraveSearchParams('en_gb'), { search_lang: 'en-gb', country: 'GB' });
    assert.deepEqual(resolveBraveSearchParams('EN-Gb'), { search_lang: 'en-gb', country: 'GB' });
  });

  it("uses Brave's own spelling, not the obvious ISO code", () => {
    // Verified against Brave's published enum (brave/brave-search-mcp-server,
    // src/tools/web/params.ts). Sending the ISO code instead would be rejected.
    assert.equal(resolveBraveSearchParams('ja').search_lang, 'jp');
    assert.equal(resolveBraveSearchParams('zh').search_lang, 'zh-hans');
    assert.equal(resolveBraveSearchParams('zh-TW').search_lang, 'zh-hant');
    assert.equal(resolveBraveSearchParams('pt').search_lang, 'pt-pt');
    assert.equal(resolveBraveSearchParams('pt-BR').search_lang, 'pt-br');
    assert.equal(resolveBraveSearchParams('en-GB').search_lang, 'en-gb');
  });

  it('sends nothing for a language Brave does not serve at all', () => {
    // Brave lists neither Greek nor Indonesian. Sending them would cost every
    // search a rejected request plus an untargeted retry, for no targeting.
    assert.deepEqual(resolveBraveSearchParams('el'), {});
    assert.deepEqual(resolveBraveSearchParams('el-GR'), {});
    assert.deepEqual(resolveBraveSearchParams('id'), {});
  });

  it('sends the region when Brave lists it', () => {
    assert.deepEqual(resolveBraveSearchParams('de-CH'), { search_lang: 'de', country: 'CH' });
  });

  it('keeps the language when the region is one Brave does not list', () => {
    // de-LI targets German content without claiming a market Brave may not
    // serve — the language is the part that matters to the answer.
    assert.deepEqual(resolveBraveSearchParams('de-LI'), { search_lang: 'de' });
  });

  it('sends nothing at all for a language Brave does not list', () => {
    // Which is exactly how Brave search behaved before language support existed,
    // so an unlisted language costs targeting, never the search itself.
    assert.deepEqual(resolveBraveSearchParams('xx'), {});
    assert.deepEqual(resolveBraveSearchParams('xx-US'), {});
  });

  it('never sends a country without a language', () => {
    // A market narrowed with Brave's default content language is not what the
    // caller asked for.
    const params = resolveBraveSearchParams('zz-DE');
    assert.equal(params.country, undefined);
  });

  it('sends nothing for missing or non-string input', () => {
    assert.deepEqual(resolveBraveSearchParams(undefined), {});
    assert.deepEqual(resolveBraveSearchParams(''), {});
    assert.deepEqual(resolveBraveSearchParams(42), {});
  });
});
