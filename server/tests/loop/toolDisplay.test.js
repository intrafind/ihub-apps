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
  activityKindOf,
  activityScopeOf,
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
  assert.deepEqual(toolDisplayOf({ id: 'webSearch', name: 'Web search' }), {
    title: 'Web search',
    activityKind: 'search',
    activityScope: 'web',
    activityOrigin: 'web'
  });
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
  assert.deepEqual(toolDisplayOf({ id: 'read_url', name: 'Read web page' }), {
    title: 'Read web page',
    activityKind: 'fetch',
    activityScope: 'web',
    activityOrigin: 'web'
  });
  assert.deepEqual(toolDisplayOf({ id: 'evidence', name: 'evidence' }), { activityKind: 'tool' });
  assert.deepEqual(toolDisplayOf({ id: 'x', name: { en: 'Not localized' } }), {
    activityKind: 'tool'
  });
  assert.deepEqual(toolDisplayOf(null), {});
});

test('the origin of a call is the footer’s kind, decided by the server', () => {
  const origin = toolDef => toolDisplayOf(toolDef).activityOrigin;
  assert.equal(origin({ id: 'braveSearch' }), 'web');
  assert.equal(origin({ id: 'read_url' }), 'web', 'the page reader reads the web');
  assert.equal(origin({ id: 'knowledge_search' }), 'project');
  assert.equal(origin({ id: 'knowledge_read' }), 'project');
  assert.equal(origin({ id: 'iFinder_search' }), 'ifinder');
  assert.equal(origin({ id: 'iFinder_getContent' }), 'ifinder');
  // What an admin configured is "documents", never a project.
  assert.equal(origin({ id: 'source_handbook' }), 'documents');
  assert.equal(
    origin({ id: 'jira_x', _integration: { definition: 'com.intrafind/jira' } }),
    'integration'
  );
  assert.equal(
    origin({ id: 'mcp_x', _mcp: { serverId: 's', originalName: 'search' } }),
    'integration'
  );
  // A web search integration is the web, an MCP tool named like one is not.
  assert.equal(
    origin({ id: 'mcp_brave', _mcp: { serverId: 'brave', originalName: 'web_search' } }),
    'integration'
  );
  // Calls the server cannot place say nothing: the chat never guesses.
  assert.equal(origin({ id: 'create_pdf' }), undefined);
  assert.equal(origin({ id: 'search_tools', isInternalTool: true }), undefined);
  assert.equal(origin({ id: 'researchplanner' }), undefined);
  assert.equal(origin(null), undefined);
});

test('the activity line and the footer read one classifier', () => {
  // Every knowledge source the seam records maps onto the kind the footer names.
  for (const [source, kind] of [
    ['project', 'project'],
    ['websearch', 'web'],
    ['grounding', 'web'],
    ['ifinder', 'ifinder'],
    ['sources', 'documents'],
    ['integration', 'integration']
  ]) {
    assert.equal(activityOriginOfSource(source), kind);
    assert.deepEqual(answerBasisOf({ knowledgeSources: [source] })[0].kind, kind);
  }
  assert.equal(activityOriginOfSource('email'), undefined, 'an input of the turn is not a call');
  assert.equal(activityOriginOfSource('llm'), undefined);
});

test('the row kind: searches, page and document reads, plain calls', () => {
  assert.equal(activityKindOf('braveSearch', 'websearch'), 'search');
  assert.equal(activityKindOf('source_handbook', 'sources'), 'search');
  assert.equal(activityKindOf('read_url', null), 'fetch');
  assert.equal(activityKindOf('iFinder_getContent', 'ifinder'), 'fetch');
  assert.equal(activityKindOf('jira', null), 'tool');
  // A people search finds people, not pages or documents.
  assert.equal(activityKindOf('entraPeopleSearch', null), 'tool');
  // A connected system's search is a plain call, whatever its id says.
  assert.equal(activityKindOf('jira_searchTickets', 'integration'), 'tool');
  assert.equal(activityKindOf('x500bund__search_people', 'integration'), 'tool');
});

test('the scope: the documents of the organisation or the web', () => {
  assert.equal(activityScopeOf('iFinder_search', 'ifinder'), 'documents');
  assert.equal(activityScopeOf('source_handbook', 'sources'), 'documents');
  assert.equal(activityScopeOf('companySearch', 'ifinder'), 'documents');
  assert.equal(activityScopeOf('braveSearch', 'websearch'), 'web');
  assert.equal(activityScopeOf('read_url', null), 'web');
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
