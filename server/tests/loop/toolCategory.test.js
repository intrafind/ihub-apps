// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a tool is (a search, a fetch or a plain call, and where it looks) is a
 * property of the tool, resolved once. Nothing here is read from the tool id.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activityDeclarationSchema,
  categoryOf,
  isCitationProducing
} from '../../services/tools/toolCategory.js';

const mcp = id => ({ id, _mcp: { serverId: 's' }, _integration: { definition: 'mcp/s' } });

test('a tool that declares nothing is a plain call, whatever its id says', () => {
  for (const id of [
    'foo_search',
    'jira_searchIssues',
    'entraPeopleSearch',
    'webSearch',
    'read_url'
  ]) {
    assert.deepEqual(categoryOf({ id }), { kind: 'tool' }, id);
  }
});

test('a connected system is origin integration, a plain call without a declaration', () => {
  assert.deepEqual(categoryOf(mcp('foo_search')), { kind: 'tool', origin: 'integration' });
  assert.deepEqual(categoryOf({ id: 'a', _a2a: { agentId: 'x' } }), {
    kind: 'tool',
    origin: 'integration'
  });
  assert.deepEqual(categoryOf({ id: 'jira_searchTickets', _integration: { definition: 'j' } }), {
    kind: 'tool',
    origin: 'integration'
  });
});

test("iHub's own integration and the loop's internal tools have no origin", () => {
  assert.deepEqual(
    categoryOf({ id: 'ask_user', _integration: { definition: 'com.intrafind/ihub' } }),
    {
      kind: 'tool'
    }
  );
  assert.deepEqual(
    categoryOf({
      id: 'search_tools',
      isInternalTool: true,
      activity: { kind: 'search', origin: 'web' }
    }),
    { kind: 'tool' }
  );
});

test('a declaration wins; the origin falls back to the connected system', () => {
  assert.deepEqual(
    categoryOf({ ...mcp('foo_search'), activity: { kind: 'search', origin: 'web' } }),
    { kind: 'search', origin: 'web' }
  );
  assert.deepEqual(categoryOf({ ...mcp('dir'), activity: { kind: 'search' } }), {
    kind: 'search',
    origin: 'integration'
  });
  assert.deepEqual(categoryOf({ id: 'x', activity: { kind: 'fetch', origin: 'project' } }), {
    kind: 'fetch',
    origin: 'project'
  });
});

test("a function's declaration wins over its tool's", () => {
  const tool = {
    id: 'docs_read',
    method: 'read',
    activity: { kind: 'search', origin: 'documents' },
    functions: { read: { activity: { kind: 'fetch', origin: 'documents' } }, list: {} }
  };
  assert.deepEqual(categoryOf(tool), { kind: 'fetch', origin: 'documents' });
  assert.deepEqual(categoryOf({ ...tool, method: 'list' }), {
    kind: 'search',
    origin: 'documents'
  });
});

test('an invalid declaration is ignored: the tool stays a plain call', () => {
  for (const activity of [
    { kind: 'lookup' },
    { kind: 'search', origin: 'people' },
    { kind: 'search', scope: 'web' },
    'search'
  ]) {
    assert.deepEqual(categoryOf({ id: 'x', activity }), { kind: 'tool' });
  }
});

test('the schema accepts the documented shapes only', () => {
  assert.ok(activityDeclarationSchema.safeParse({ kind: 'search', origin: 'web' }).success);
  assert.ok(activityDeclarationSchema.safeParse({ kind: 'tool', place: 'directory' }).success);
  assert.ok(!activityDeclarationSchema.safeParse({}).success);
  assert.ok(!activityDeclarationSchema.safeParse({ kind: 'search', origin: 'tickets' }).success);
});

test('searches and fetches produce citations; plain calls do not', () => {
  assert.equal(isCitationProducing({ id: 'x', activity: { kind: 'search' } }), true);
  assert.equal(isCitationProducing({ id: 'x', activity: { kind: 'fetch' } }), true);
  assert.equal(isCitationProducing({ id: 'jira_searchIssues', _mcp: {} }), false);
  assert.equal(isCitationProducing(undefined), false);
});
