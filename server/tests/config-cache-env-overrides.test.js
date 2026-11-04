// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `IHUB_PLATFORM__*` and `IHUB_UI__*` variables override platform.json and
 * ui.json as the config cache resolves them: `__` separates path segments,
 * each segment becomes camelCase, and values are coerced. A malformed name is
 * skipped, and an override of a block that moved into an installed
 * integration (V192) is ignored with one warning per variable.
 */
import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import configCache from '../configCache.js';

const SET = [];

/** Set a variable for one test; `afterEach` removes it again. */
function setEnv(name, value) {
  SET.push(name);
  process.env[name] = value;
}

afterEach(() => {
  for (const name of SET.splice(0)) delete process.env[name];
  mock.restoreAll();
});

describe('IHUB_* overrides in the config cache', () => {
  it('sets the nested camelCase path with a coerced value', () => {
    setEnv('IHUB_UI__HEADER__DEFAULT_TITLE', 'From env');
    setEnv('IHUB_UI__HEADER__MAX_ITEMS', '7');
    const { data } = configCache._resolveEntry('config/ui.json', {
      header: { defaultTitle: 'From file' }
    });
    assert.equal(data.header.defaultTitle, 'From env');
    assert.equal(data.header.maxItems, 7);
  });

  it('skips a variable with nothing after the prefix or an empty segment', () => {
    setEnv('IHUB_UI__', 'x');
    setEnv('IHUB_UI__HEADER____TITLE', 'x');
    const { data } = configCache._resolveEntry('config/ui.json', { header: {} });
    assert.deepEqual(data, { header: {} });
  });

  it('applies only the prefix of the config being resolved', () => {
    setEnv('IHUB_PLATFORM__DEFAULT_LANGUAGE', 'de');
    const { data: ui } = configCache._resolveEntry('config/ui.json', {});
    assert.deepEqual(ui, {});
    const { data: platform } = configCache._resolveEntry('config/platform.json', {});
    assert.equal(platform.defaultLanguage, 'de');
  });
});
