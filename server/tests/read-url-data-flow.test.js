// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The page reader sends whatever its URL carries to the host it opens, so it is an
 * external tool: `toolApproval.defaults.external` must apply to it, as
 * docs/tool-approval.md recommends for tools that may leak internal data.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { platformToolDefinitions } = await import('../services/tools/platformTools.js');
const { resolveDataFlow, resolveSideEffect } = await import('../utils/toolApproval.js');

describe('read_url data flow', () => {
  it('is external, so the platform default for external tools applies', () => {
    const reader = platformToolDefinitions().find(tool => tool.id === 'read_url');
    assert.ok(reader, 'read_url is a platform tool');
    assert.equal(resolveDataFlow(reader), 'external');
  });

  it('is a read, so only an "always" default asks before a page read', () => {
    const reader = platformToolDefinitions().find(tool => tool.id === 'read_url');
    assert.deepEqual(resolveSideEffect(reader), { sideEffect: 'read', sideEffectSource: 'tool' });
  });

  it('every other platform tool keeps its own data flow', () => {
    for (const tool of platformToolDefinitions().filter(t => t.id !== 'read_url')) {
      assert.equal(resolveDataFlow(tool), 'internal', tool.id);
    }
  });
});
