// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The chat shows a tool call by the action and the system it ran against,
 * not by the id the model called it by.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTPUT_KINDS,
  outputKindOf,
  activityOriginOfSource,
  startedDisplayOf,
  toolDisplayOf
} from '../../utils/toolDisplay.js';
import { answerBasisOf } from '../../services/chat/answerBasis.js';
import { SYSTEM_SKILL_TOOL_IDS, systemSkillToolsFor } from '../../services/systemSkillTools.js';

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
    {
      title: 'Search people',
      integration: 'Munich AD',
      activityKind: 'tool',
      activityOrigin: 'integration'
    }
  );
});

test('a connected system says so, so the chat does not draw its search as a web search', () => {
  assert.deepEqual(
    toolDisplayOf({
      id: 'jira_searchTickets',
      _integration: {
        definition: 'com.intrafind/jira',
        instanceLabel: 'Jira',
        actionTitle: 'Search tickets'
      }
    }),
    {
      title: 'Search tickets',
      integration: 'Jira',
      activityKind: 'tool',
      activityOrigin: 'integration'
    }
  );
  assert.deepEqual(
    toolDisplayOf({
      id: 'webSearch',
      name: 'Web search',
      activity: { kind: 'search', origin: 'web' }
    }),
    {
      title: 'Web search',
      activityKind: 'search',
      activityOrigin: 'web'
    }
  );
});

test('an MCP tool reads as its title (else its own name) and its server', () => {
  assert.deepEqual(
    toolDisplayOf({
      id: 'mcp_github__search_code',
      name: 'mcp_github__search_code',
      _mcp: { serverId: 'github', serverName: 'GitHub', originalName: 'search_code' }
    }),
    {
      title: 'search_code',
      integration: 'GitHub',
      activityKind: 'tool',
      activityOrigin: 'integration'
    }
  );
  assert.deepEqual(
    toolDisplayOf({
      id: 'x',
      _mcp: { serverId: 'github', originalName: 'search_code', title: 'Search code' }
    }),
    {
      title: 'Search code',
      integration: 'github',
      activityKind: 'tool',
      activityOrigin: 'integration'
    }
  );
});

test('a remote agent skill reads as the skill and the agent', () => {
  assert.deepEqual(
    toolDisplayOf({
      id: 'a2a__x__y',
      _a2a: { agentId: 'x', agentName: 'Travel', skillName: 'Book' }
    }),
    {
      title: 'Book',
      integration: 'Travel',
      activityKind: 'tool',
      activityOrigin: 'integration'
    }
  );
});

test('any other tool reads as its name when that says more than its id', () => {
  assert.deepEqual(
    toolDisplayOf({
      id: 'read_url',
      name: 'Read web page',
      activity: { kind: 'fetch', origin: 'web' }
    }),
    {
      title: 'Read web page',
      activityKind: 'fetch',
      activityOrigin: 'web'
    }
  );
  assert.deepEqual(toolDisplayOf({ id: 'evidence', name: 'evidence' }), { activityKind: 'tool' });
  assert.deepEqual(toolDisplayOf({ id: 'x', name: { en: 'Not localized' } }), {
    activityKind: 'tool'
  });
  assert.deepEqual(toolDisplayOf(null), {});
});

test('the origin of a call is the footer’s kind, decided by the server from the declaration', () => {
  const origin = toolDef => toolDisplayOf(toolDef).activityOrigin;
  const declared = (id, kind, from) => ({ id, activity: { kind, origin: from } });
  assert.equal(origin(declared('braveSearch', 'search', 'web')), 'web');
  assert.equal(
    origin(declared('read_url', 'fetch', 'web')),
    'web',
    'the page reader reads the web'
  );
  assert.equal(origin(declared('knowledge_search', 'search', 'project')), 'project');
  assert.equal(origin(declared('knowledge_read', 'fetch', 'project')), 'project');
  assert.equal(origin(declared('iFinder_search', 'search', 'ifinder')), 'ifinder');
  assert.equal(origin(declared('iFinder_getContent', 'fetch', 'ifinder')), 'ifinder');
  assert.equal(
    origin({ id: 'jira_x', _integration: { definition: 'com.intrafind/jira' } }),
    'integration'
  );
  assert.equal(
    origin({ id: 'mcp_x', _mcp: { serverId: 's', originalName: 'search' } }),
    'integration'
  );
  // An MCP tool named like a web search is not one until an admin declares it.
  const mcpBrave = { id: 'mcp_brave', _mcp: { serverId: 'brave', originalName: 'web_search' } };
  assert.equal(origin(mcpBrave), 'integration');
  assert.equal(origin({ ...mcpBrave, activity: { kind: 'search', origin: 'web' } }), 'web');
  // Calls the server cannot place say nothing: the chat never guesses, nor reads the id.
  for (const id of [
    'create_pdf',
    'braveSearch',
    'knowledge_search',
    'source_handbook',
    'researchplanner'
  ]) {
    assert.equal(origin({ id }), undefined, id);
  }
  assert.equal(origin({ id: 'search_tools', isInternalTool: true }), undefined);
  assert.equal(origin(null), undefined);
});

test('the activity line and the footer read one classifier', () => {
  // Every knowledge source the seam records maps onto the kind the footer names.
  for (const [source, kind] of [
    ['project', 'project'],
    ['websearch', 'web'],
    ['grounding', 'web'],
    ['ifinder', 'ifinder'],
    ['sources', 'project'],
    ['integration', 'integration']
  ]) {
    assert.equal(activityOriginOfSource(source), kind);
    assert.deepEqual(answerBasisOf({ knowledgeSources: [source] })[0].kind, kind);
  }
  assert.equal(activityOriginOfSource('email'), undefined, 'an input of the turn is not a call');
  assert.equal(activityOriginOfSource('llm'), undefined);
});

test("the row kind and origin are the tool's declared category, never read from its id", () => {
  const display = tool => {
    const { activityKind, activityOrigin } = toolDisplayOf(tool);
    return [activityKind, activityOrigin];
  };
  // What a tool declares is what it is.
  assert.deepEqual(display({ id: 'braveSearch', activity: { kind: 'search', origin: 'web' } }), [
    'search',
    'web'
  ]);
  assert.deepEqual(display({ id: 'read_url', activity: { kind: 'fetch', origin: 'web' } }), [
    'fetch',
    'web'
  ]);
  assert.deepEqual(
    display({ id: 'iFinder_getContent', activity: { kind: 'fetch', origin: 'ifinder' } }),
    ['fetch', 'ifinder']
  );
  // A tool that declares nothing is a plain call, even when its id says search or people.
  for (const id of ['jira', 'entraPeopleSearch', 'webSearch', 'source_handbook', 'foo_search']) {
    assert.deepEqual(display({ id }), ['tool', undefined], id);
  }
  // A connected system without a declaration is a plain call of origin integration.
  for (const id of ['jira_searchIssues', 'jira_searchTickets', 'foo_search']) {
    assert.deepEqual(display({ id, _mcp: { serverId: 's' } }), ['tool', 'integration'], id);
  }
  // A directory lookup declares itself a search of the connected system.
  assert.deepEqual(
    display({
      id: 'x500bund__search_people',
      activity: { kind: 'search', origin: 'integration' },
      _integration: { definition: 'com.intrafind/ldap-directory' }
    }),
    ['search', 'integration']
  );
  // The loop's own tools are plain calls whatever they declare.
  assert.deepEqual(
    display({ id: 'search_tools', isInternalTool: true, activity: { kind: 'search' } }),
    ['tool', undefined]
  );
});

test('where a call looked is its `activityOrigin`: no web/documents scope is sent any more', () => {
  for (const id of [
    'iFinder_search',
    'source_handbook',
    'companySearch',
    'braveSearch',
    'read_url',
    'knowledge_search'
  ]) {
    for (const display of [toolDisplayOf({ id }), startedDisplayOf({ id })]) {
      assert.equal('activityScope' in display, false, id);
      assert.ok(display.activityKind, `${id} is still drawn by its kind`);
    }
  }
});

// ── what a creator tool produces ────────────────────────────────────────────

/** The tools the system skills bring, as an app offers them to the model. */
const creatorTools = systemSkillToolsFor(
  [{ name: 'all', isSystem: true, providedTools: [...SYSTEM_SKILL_TOOL_IDS] }],
  { language: 'en' }
);

test('the built-in creators say what they produce; the server decides, not the id', () => {
  const kinds = Object.fromEntries(creatorTools.map(tool => [tool.id, outputKindOf(tool)]));
  assert.deepEqual(kinds, {
    create_pdf: 'pdf',
    preview_pdf: undefined,
    create_docx: 'document',
    create_pptx: 'presentation',
    restyle_pptx: 'presentation',
    create_xlsx: 'workbook',
    create_web_artifact: 'webArtifact',
    // Changes a file rather than creating one: its row reads "Edit web artifact".
    edit_web_artifact: undefined,
    create_file: 'file',
    create_zip: 'archive'
  });
  for (const kind of Object.values(kinds).filter(Boolean)) assert.ok(OUTPUT_KINDS.includes(kind));
  assert.equal(
    new Set(Object.values(kinds).filter(Boolean)).size,
    7,
    'seven creators, seven kinds'
  );
});

test('only a system-skill tool can claim an output kind', () => {
  assert.equal(outputKindOf(null), undefined);
  assert.equal(outputKindOf({ id: 'create_pdf' }), undefined, 'the id says nothing');
  assert.equal(
    outputKindOf({ id: 'x', outputKind: 'pdf' }),
    undefined,
    'an admin tool cannot claim one'
  );
  assert.equal(
    outputKindOf({ id: 'mcp__x', outputKind: 'pdf', _mcp: { serverId: 'x' } }),
    undefined
  );
  assert.equal(
    outputKindOf({ id: 'x', isSystemSkillTool: true, outputKind: 'spaceship' }),
    undefined
  );
  assert.equal(outputKindOf({ id: 'x', isSystemSkillTool: true, outputKind: 'pdf' }), 'pdf');
});

test('toolDisplayOf carries the kind; the display of tool/started and the ledger does not', () => {
  const webArtifact = creatorTools.find(tool => tool.id === 'create_web_artifact');
  assert.deepEqual(toolDisplayOf(webArtifact), {
    title: 'Create interactive web artifact',
    activityKind: 'tool',
    outputKind: 'webArtifact'
  });
  assert.deepEqual(startedDisplayOf(webArtifact), {
    title: 'Create interactive web artifact',
    activityKind: 'tool'
  });
  // A tool without a kind is the same in both.
  const preview = creatorTools.find(tool => tool.id === 'preview_pdf');
  assert.deepEqual(startedDisplayOf(preview), toolDisplayOf(preview));
  assert.deepEqual(startedDisplayOf(null), {});
});
