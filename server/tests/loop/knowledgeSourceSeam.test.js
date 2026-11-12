// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Knowledge-source badge vocabulary: which tools count as a web search. iFinder
 * searches the organisation's document index, so its answers must not be
 * badged "Based on web search".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyKnowledgeSource } from '../../services/loop/seams/knowledgeSourceSeam.js';

test('web search tools are web search', () => {
  assert.equal(classifyKnowledgeSource('braveSearch'), 'websearch');
  assert.equal(classifyKnowledgeSource('qwantSearch'), 'websearch');
  assert.equal(classifyKnowledgeSource('webSearch'), 'websearch');
});

test('iFinder functions are iFinder documents, not web search', () => {
  assert.equal(classifyKnowledgeSource('iFinder_search'), 'ifinder');
  assert.equal(classifyKnowledgeSource('iFinder_getContent'), 'ifinder');
  assert.equal(classifyKnowledgeSource('iFinder.search'), 'ifinder');
});

test('configured sources and unrelated tools keep their classification', () => {
  assert.equal(classifyKnowledgeSource('source_handbook'), 'sources');
  assert.equal(classifyKnowledgeSource('entraPeopleSearch'), null);
  assert.equal(classifyKnowledgeSource('jira'), null);
  assert.equal(classifyKnowledgeSource(''), null);
});

test('an integration, MCP server or remote agent is a connected system', async () => {
  const { classifyToolKnowledgeSource } =
    await import('../../services/loop/seams/knowledgeSourceSeam.js');
  const { publishDefinitionTypes } =
    await import('../../services/integrations/integrationTypes.js');
  publishDefinitionTypes([
    { definition: { id: 'com.intrafind/ldap-directory', type: 'people-directory' } },
    { definition: { id: 'com.intrafind/brave-search', type: 'web-search' } }
  ]);
  const integration = (definition, instanceId = 'x') => ({
    _integration: { definition, instanceId }
  });
  // A directory lookup is not "AI knowledge" — the answer came from the directory.
  assert.equal(
    classifyToolKnowledgeSource(
      'muc-ad__search_people',
      integration('com.intrafind/ldap-directory')
    ),
    'integration'
  );
  // A Jira search is not a web search, whatever its id says.
  assert.equal(
    classifyToolKnowledgeSource('jira_searchTickets', integration('com.intrafind/jira')),
    'integration'
  );
  // A web-search integration stays a web search; iFinder keeps its badge.
  assert.equal(
    classifyToolKnowledgeSource('braveSearch', integration('com.intrafind/brave-search')),
    'websearch'
  );
  assert.equal(
    classifyToolKnowledgeSource('iFinder_search', integration('com.intrafind/ifinder')),
    'ifinder'
  );
  // iHub's own tools are not a connected system.
  assert.equal(
    classifyToolKnowledgeSource('schedule_task', integration('com.intrafind/ihub')),
    null
  );
  assert.equal(
    classifyToolKnowledgeSource('github__search_code', { _mcp: { serverId: 'github' } }),
    'integration'
  );
  assert.equal(
    classifyToolKnowledgeSource('a2a__agent__skill', { _a2a: { agentId: 'agent' } }),
    'integration'
  );
  // Without a definition the id decides, as before.
  assert.equal(classifyToolKnowledgeSource('webSearch', { id: 'webSearch' }), 'websearch');
  publishDefinitionTypes([]);
});

test('a connected system counts only when the call returned data', async () => {
  const { knowledgeSourceSeam } = await import('../../services/loop/seams/knowledgeSourceSeam.js');
  const run = message => {
    const added = [];
    const outcome = { message, error: null };
    knowledgeSourceSeam.postTool(
      { addKnowledgeSource: source => added.push(source), addIntegration: () => {} },
      { toolId: 'muc-ad__get_person', toolDef: { _integration: { definition: 'd' } } },
      outcome
    );
    return { added, source: outcome.knowledgeSource };
  };
  assert.deepEqual(run({ role: 'tool', content: '{"name":"Daniel"}' }), {
    added: ['integration'],
    source: 'integration'
  });
  assert.deepEqual(run({ role: 'tool', content: '{"error":true,"message":"down"}' }), {
    added: [],
    source: undefined
  });
});

test('a recalled source counts as the kind of source it was found as', async () => {
  const { classifySourceProvider } =
    await import('../../services/loop/seams/knowledgeSourceSeam.js');
  // Web pages, the providers' own search (grounding) included.
  assert.equal(classifySourceProvider('web'), 'websearch');
  // iFinder documents, iAssistant's included.
  assert.equal(classifySourceProvider('ifinder'), 'ifinder');
  assert.equal(classifySourceProvider('project'), 'project');
  // An MCP server is a connected system, even one that searches.
  assert.equal(classifySourceProvider('mcp:brave-search'), 'integration');
  // Otherwise the provider is the id of the tool that found it.
  assert.equal(classifySourceProvider('braveSearch'), 'websearch');
  assert.equal(classifySourceProvider('source_handbook'), 'sources');
  assert.equal(classifySourceProvider('jira'), 'integration');
});

test('reading an earlier source badges the answer; listing them does not', async () => {
  const { knowledgeSourceSeam } = await import('../../services/loop/seams/knowledgeSourceSeam.js');
  const run = (toolId, outcome) => {
    const added = [];
    const ctx = { addKnowledgeSource: source => added.push(source) };
    knowledgeSourceSeam.postTool(ctx, { toolId }, outcome);
    return { added, outcome };
  };
  const recalled = {
    sources: {
      items: [
        { id: 'url:a', provider: 'web' },
        { id: 'url:b', provider: 'web' },
        { id: 'ifinder:d1', provider: 'ifinder' }
      ]
    }
  };
  const read = run('chat_sources_read', { ...recalled });
  assert.deepEqual(read.added, ['websearch', 'ifinder']);
  assert.equal(read.outcome.knowledgeSource, 'websearch');

  // The list reads no content.
  assert.deepEqual(run('chat_sources_list', { ...recalled }).added, []);
  // A read that found nothing, or failed, informs nothing.
  assert.deepEqual(run('chat_sources_read', { sources: null }).added, []);
  assert.deepEqual(run('chat_sources_read', { ...recalled, error: 'boom' }).added, []);
  // The other chat context tools are not knowledge sources.
  assert.deepEqual(run('chat_files_read', {}).added, []);
  assert.deepEqual(run('chat_artifacts_read', {}).added, []);
});
