// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The chat shows a tool call by the action and the system it ran against,
 * not by the id the model called it by.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toolDisplayOf } from '../../utils/toolDisplay.js';

test('an integration action reads as its title and installation label', () => {
  assert.deepEqual(
    toolDisplayOf({
      id: 'muc-ad__search_people',
      name: 'Munich AD: Search people',
      _integration: {
        instanceId: 'muc-ad',
        instanceLabel: 'Munich AD',
        action: 'search_people',
        actionTitle: 'Search people'
      }
    }),
    { title: 'Search people', integration: 'Munich AD' }
  );
});

test('an MCP tool reads as its title (else its own name) and its server', () => {
  assert.deepEqual(
    toolDisplayOf({
      id: 'mcp_github__search_code',
      name: 'mcp_github__search_code',
      _mcp: { serverId: 'github', serverName: 'GitHub', originalName: 'search_code' }
    }),
    { title: 'search_code', integration: 'GitHub' }
  );
  assert.deepEqual(
    toolDisplayOf({
      id: 'x',
      _mcp: { serverId: 'github', originalName: 'search_code', title: 'Search code' }
    }),
    { title: 'Search code', integration: 'github' }
  );
});

test('a remote agent skill reads as the skill and the agent', () => {
  assert.deepEqual(
    toolDisplayOf({
      id: 'a2a__x__y',
      _a2a: { agentId: 'x', agentName: 'Travel', skillName: 'Book' }
    }),
    { title: 'Book', integration: 'Travel' }
  );
});

test('any other tool reads as its name when that says more than its id', () => {
  assert.deepEqual(toolDisplayOf({ id: 'read_url', name: 'Read web page' }), {
    title: 'Read web page'
  });
  assert.deepEqual(toolDisplayOf({ id: 'read_url', name: 'read_url' }), {});
  assert.deepEqual(toolDisplayOf({ id: 'x', name: { en: 'Not localized' } }), {});
  assert.deepEqual(toolDisplayOf(null), {});
});
