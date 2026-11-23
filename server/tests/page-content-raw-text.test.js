// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dropRawTextElements } from '../services/pageReader/pageContent.js';

describe('dropRawTextElements tag list', () => {
  it('drops the named elements, whatever the case of their tags', () => {
    assert.equal(
      dropRawTextElements('a<SCRIPT type="x">b</script >c<style>d</style>e', ['script', 'style']),
      'ace'
    );
  });

  it('accepts tag names with a hyphen', () => {
    assert.equal(dropRawTextElements('a<my-raw>b</my-raw>c', ['my-raw']), 'ac');
  });

  it('refuses anything that is not a plain tag name before it reaches a regex', () => {
    for (const tag of ['.*', 'a|', '(script)', 'script)(?:', '', '[a-z]+', 'a b']) {
      assert.throws(() => dropRawTextElements('<script>x</script>', [tag]), TypeError, tag);
    }
  });
});
