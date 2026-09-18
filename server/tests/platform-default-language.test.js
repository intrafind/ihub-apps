#!/usr/bin/env node

/**
 * `platform.defaultLanguage` stays editable from the admin UI.
 *
 * The admin platform-config handler is a read-modify-write whose merge emits
 * **only the keys it names**, spread over the stored config. A key that is not
 * named is therefore not rejected and not reported — it is silently reverted by
 * the spread on the very next save, which is the failure the `mcpServer` comment
 * in that handler already records having been hit once.
 *
 * `defaultLanguage` is worth guarding that way because its blast radius is
 * invisible: it is the fallback for every localized lookup, and the language web
 * search runs in whenever a request carries none of its own (a workflow or agent
 * run). A silent revert would send a German install back to searching the US
 * market with the admin page still showing "Deutsch".
 *
 * Source-reading drift guards are the established pattern here — see the schema
 * enum guard in `websearch-provider-selection.test.js`.
 *
 * Run: node --test server/tests/platform-default-language.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { platformConfigSchema } from '../validators/platformConfigSchema.js';
import { isValidLanguageCode } from '../utils/pathSecurity.js';

const routeSource = () =>
  readFile(new URL('../routes/admin/configs.js', import.meta.url), 'utf8');

describe('platform.defaultLanguage', () => {
  it('is declared in the platform schema', () => {
    const parsed = platformConfigSchema.parse({ defaultLanguage: 'de' });
    assert.equal(parsed.defaultLanguage, 'de');
  });

  it('defaults to English when the config omits it', () => {
    assert.equal(platformConfigSchema.parse({}).defaultLanguage, 'en');
  });

  it('is named in the admin save merge, so a save is not silently reverted', async () => {
    const source = await routeSource();
    const merge = /const mergedConfig = \{([\s\S]*?)\n      \};/.exec(source);
    assert.ok(merge, 'could not locate mergedConfig in routes/admin/configs.js');
    assert.match(
      merge[1],
      /defaultLanguage:/,
      'defaultLanguage is missing from the merge — an admin save would appear to succeed and revert on the next write'
    );
  });

  it('is validated before it is written', async () => {
    const source = await routeSource();
    assert.match(
      source,
      /isValidLanguageCode\(newConfig\.defaultLanguage\)/,
      'defaultLanguage reaches platform.json without a validity check'
    );
  });

  it('rejects the values that check exists to catch', () => {
    // A bad default language is not cosmetic: it is substituted into localized
    // lookups and into a search request's locale.
    for (const bad of ['../../etc/passwd', 'en;rm -rf /', '', '   ', 'a'.repeat(40)]) {
      assert.equal(isValidLanguageCode(bad), false, bad);
    }
    for (const good of ['en', 'de', 'en-GB', 'de-CH']) {
      assert.equal(isValidLanguageCode(good), true, good);
    }
  });
});
