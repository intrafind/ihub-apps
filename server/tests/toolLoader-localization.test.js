// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Localization of the platform tools (`loadPlatformTools`). A model provider
 * rejects a tool whose description is still a `{ en, de }` object, so every
 * description in a tool — the tool's own and every nested parameter's — must
 * come out as a string, whatever language the caller passes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlatformTools } from '../services/tools/catalog.js';

/** Every `description` found anywhere below `node`. */
function descriptionsOf(node, found = []) {
  if (Array.isArray(node)) {
    node.forEach(item => descriptionsOf(item, found));
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'description') found.push(value);
      else descriptionsOf(value, found);
    }
  }
  return found;
}

describe('Tool Localization', () => {
  for (const [label, language] of [
    ['a language', 'en'],
    ['German', 'de'],
    ['null (the platform default)', null],
    ['undefined', undefined],
    ['an empty string', '']
  ]) {
    it(`localizes every description for ${label}`, () => {
      const tools = loadPlatformTools(language);
      assert.ok(tools.length > 0, 'the platform tools are loaded');
      for (const tool of tools) {
        assert.equal(typeof tool.description, 'string', `${tool.id} description`);
        for (const description of descriptionsOf(tool.parameters)) {
          assert.equal(typeof description, 'string', `${tool.id} parameter description`);
        }
      }
    });
  }

  it('uses the requested language', () => {
    const english = loadPlatformTools('en').find(t => t.id === 'read_url');
    const german = loadPlatformTools('de').find(t => t.id === 'read_url');
    assert.ok(english && german, 'read_url is a platform tool');
    assert.ok(german.description.length > 0);
  });
});
