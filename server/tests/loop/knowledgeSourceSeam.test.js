// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Knowledge-source badge vocabulary: which tools count as a web search. It is
 * the tool's declared category, never its id: iFinder searches the
 * organisation's document index, so its answers must not be badged "Based on
 * web search", and neither must a people directory, Jira or an MCP tool that
 * merely has "search" in its name.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyToolKnowledgeSource } from '../../services/loop/seams/knowledgeSourceSeam.js';

const web = { activity: { kind: 'search', origin: 'web' } };

test('a tool that declares a web search is web search, by its declaration and not its id', () => {
  assert.equal(classifyToolKnowledgeSource({ id: 'braveSearch', ...web }), 'websearch');
  assert.equal(classifyToolKnowledgeSource({ id: 'anything', ...web }), 'websearch');
  assert.equal(
    classifyToolKnowledgeSource({ id: 'read_url', activity: { kind: 'fetch', origin: 'web' } }),
    'websearch'
  );
});

test('iFinder and project knowledge keep their own badge', () => {
  const ifinder = id => ({ id, activity: { kind: 'search', origin: 'ifinder' } });
  assert.equal(classifyToolKnowledgeSource(ifinder('iFinder_search')), 'ifinder');
  assert.equal(classifyToolKnowledgeSource(ifinder('iFinder_getContent')), 'ifinder');
  assert.equal(
    classifyToolKnowledgeSource({
      id: 'knowledge_search',
      activity: { kind: 'search', origin: 'project' }
    }),
    'project'
  );
});

test('a tool that declares nothing is not a source, whatever its id says', () => {
  for (const id of [
    'webSearch',
    'entraPeopleSearch',
    'jira_searchIssues',
    'foo_search',
    'source_handbook'
  ]) {
    assert.equal(classifyToolKnowledgeSource({ id }), null, id);
  }
  assert.equal(classifyToolKnowledgeSource(undefined), null);
});

test('an integration, MCP server or remote agent is a connected system', async () => {
  const integration = (definition, instanceId = 'x') => ({
    _integration: { definition, instanceId }
  });
  // A directory lookup is not "AI knowledge" — the answer came from the directory.
  assert.equal(
    classifyToolKnowledgeSource({
      id: 'muc-ad__search_people',
      activity: { kind: 'search', origin: 'integration' },
      ...integration('com.intrafind/ldap-directory')
    }),
    'integration'
  );
  // A Jira search is not a web search, whatever its id says.
  assert.equal(
    classifyToolKnowledgeSource({
      id: 'jira_searchIssues',
      ...integration('com.intrafind/jira')
    }),
    'integration'
  );
  // A web-search integration declares the web (the generator sets it).
  assert.equal(
    classifyToolKnowledgeSource({
      id: 'braveSearch',
      ...web,
      ...integration('com.intrafind/brave-search')
    }),
    'websearch'
  );
  // iHub's own tools are not a connected system.
  assert.equal(
    classifyToolKnowledgeSource({ id: 'schedule_task', ...integration('com.intrafind/ihub') }),
    null
  );
  assert.equal(
    classifyToolKnowledgeSource({ id: 'github__search_code', _mcp: { serverId: 'github' } }),
    'integration'
  );
  // An MCP tool an admin declared a web search says so; the id never does.
  assert.equal(
    classifyToolKnowledgeSource({ id: 'foo_search', _mcp: { serverId: 's' }, ...web }),
    'websearch'
  );
  assert.equal(
    classifyToolKnowledgeSource({ id: 'a2a__agent__skill', _a2a: { agentId: 'agent' } }),
    'integration'
  );
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
  // Any other provider is a connected system; a provider id is never read as a tool id.
  assert.equal(classifySourceProvider('braveSearch'), 'integration');
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
