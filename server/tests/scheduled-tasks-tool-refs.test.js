// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A chat's `enabledTools` holds tool references, a scheduled task stores tool
 * ids. "Schedule this…" and a task saved through the API resolve the
 * references against the tools the app offers (`resolveTaskToolRefs`), with
 * the same rule a chat narrows its tools by (`isBoundToolEnabled`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTaskToolRefs } from '../services/scheduler/tasks/taskService.js';
import { isBoundToolEnabled } from '../services/integrations/integrationTools.js';

const APP = { id: 'research', tools: ['jira', 'drawio'], integrations: { ifinder: {} } };

/** The app's tools as a run loads them. */
const TOOLS = [
  { id: 'iFinder_search', _integration: { instanceId: 'ifinder', fixedToolId: true } },
  { id: 'iFinder_getContent', _integration: { instanceId: 'ifinder', fixedToolId: true } },
  { id: 'drawio__create_diagram', _mcp: { serverId: 'drawio' } },
  { id: 'drawio__export', _mcp: { serverId: 'drawio' } },
  { id: 'jira_searchTickets' },
  { id: 'jira_createTicket' },
  { id: 'braveSearch' }
];

const resolve = refs => resolveTaskToolRefs(APP, TOOLS, refs, isBoundToolEnabled);

describe('resolveTaskToolRefs', () => {
  it('resolves an installation id, an MCP server id and a base id to the tools they select', () => {
    assert.deepEqual(resolve(['ifinder', 'drawio', 'jira']), {
      ids: [
        'iFinder_search',
        'iFinder_getContent',
        'drawio__create_diagram',
        'drawio__export',
        'jira_searchTickets',
        'jira_createTicket'
      ],
      unknown: []
    });
  });

  it('returns tool ids unchanged: a task’s own list resolves to itself', () => {
    assert.deepEqual(resolve(['jira_createTicket', 'iFinder_search', 'drawio__export']), {
      ids: ['iFinder_search', 'drawio__export', 'jira_createTicket'],
      unknown: []
    });
  });

  it('keeps answering to the old base id of a built-in that kept its tool ids', () => {
    assert.deepEqual(resolve(['iFinder']).ids, ['iFinder_search', 'iFinder_getContent']);
  });

  it('names the references that select nothing', () => {
    assert.deepEqual(resolve(['ifinder', 'gone', '', 42]), {
      ids: ['iFinder_search', 'iFinder_getContent'],
      unknown: ['gone']
    });
  });

  it('selects nothing for an empty list', () => {
    assert.deepEqual(resolve([]), { ids: [], unknown: [] });
    assert.deepEqual(resolve(undefined), { ids: [], unknown: [] });
  });
});
