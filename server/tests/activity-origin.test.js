// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "Say where an answer came from" (#3668), server and shared side: the origin
 * of a call, the declared result count and read outcome, `Source.origin`, who
 * brought a skill in, and what a stored or shared chat keeps.
 *
 * The first block states the verify-first items; each failed before the fix.
 *
 *  V1  a reopened chat keeps the search provider's name
 *  V2  an answer whose only retrieval was `read_url` is based on the web
 *  V3  a skill carried over from an earlier turn is announced
 *  V5  a web hit and the page fetched later are one source
 *  G10 a page read that delivered no text is not an opened page
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamState, reduceRunEvents, getRun } from '../../shared/run/runReducer.js';
import { buildToolActivity } from '../../shared/run/toolActivity.js';
import { boundStoredActivity, shareableActivity } from '../services/chat/runActivity.js';
import { normalizeSource, mergeSource } from '../../shared/sources/source.js';
import { sourcesFromGrounding } from '../../shared/sources/grounding.js';
import { foldSkill } from '../../shared/run/runReducer.js';
import { answerBasisOf } from '../services/chat/answerBasis.js';
import { knowledgeSourceSeam } from '../services/loop/seams/knowledgeSourceSeam.js';
import { announcedSkills } from '../routes/chat/sessionRoutes.js';
import { extractToolOutcome, extractToolSources } from '../services/sources/index.js';

const env = (seq, type, data) => ({
  v: 2,
  type,
  runId: 'r1',
  seq,
  ts: '2026-11-13T10:00:00.000Z',
  data
});

test('V1: a reopened chat keeps the provider name of a web search', () => {
  const state = reduceRunEvents(createStreamState(), [
    env(1, 'run/started', { kind: 'chat' }),
    env(2, 'tool/started', {
      step: 0,
      callId: 'c1',
      toolId: 'braveSearch',
      name: 'braveSearch',
      integration: 'Brave Search',
      activityKind: 'search',
      activityScope: 'web',
      args: { query: 'iFinder6' }
    }),
    env(3, 'tool/completed', { step: 0, callId: 'c1', toolId: 'braveSearch', name: 'braveSearch' }),
    env(4, 'run/ended', { status: 'completed' })
  ]);
  const live = buildToolActivity(getRun(state, 'r1'));
  assert.equal(live.items[0].integration, 'Brave Search', 'live row has the provider');
  const stored = boundStoredActivity({ toolActivity: live });
  assert.equal(stored.toolActivity.items[0].integration, 'Brave Search');
});

test('V2: an answer whose only retrieval was read_url is based on the web', () => {
  const added = [];
  const outcome = {
    ...extractToolOutcome({
      toolId: 'read_url',
      toolDef: { id: 'read_url' },
      result: { url: 'https://example.org/a', content: 'text' }
    }),
    rawResult: { url: 'https://example.org/a', content: 'text' },
    sources: extractToolSources({
      toolId: 'read_url',
      toolDef: { id: 'read_url' },
      args: { url: 'https://example.org/a' },
      result: { url: 'https://example.org/a', content: 'text' }
    })
  };
  knowledgeSourceSeam.postTool(
    { addKnowledgeSource: source => added.push(source), addIntegration: () => {} },
    { toolId: 'read_url', toolDef: { id: 'read_url' } },
    outcome
  );
  assert.deepEqual(answerBasisOf({ knowledgeSources: added }), [{ kind: 'web' }]);
});

test('V3: a skill carried over from an earlier turn is announced', () => {
  const frames = announcedSkills([
    { name: 'alpha', displayName: 'alpha', description: '', origin: 'chat' }
  ]);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].activatedBy, 'chat');
});

test('V3b: a skill the app switched on is not "started by the user"', () => {
  const [frame] = announcedSkills([
    { name: 'alpha', displayName: 'alpha', description: '', origin: 'app' }
  ]);
  assert.equal(frame.activatedBy, 'app');
});

test('V5: a web hit and the page fetched later are one source', () => {
  const hit = extractToolSources({
    toolId: 'braveSearch',
    toolDef: { id: 'braveSearch' },
    args: { query: 'q' },
    result: { results: [{ url: 'https://example.org/a', title: 'A' }] }
  });
  const page = extractToolSources({
    toolId: 'read_url',
    toolDef: { id: 'read_url' },
    args: { url: 'https://example.org/a' },
    result: { url: 'https://example.org/a', title: 'A', content: 'text', wordCount: 1 }
  });
  assert.equal(hit.items[0].id, page.items[0].id);
});

test('G10: a read at the end of a page delivered no text and is not "opened"', () => {
  const result = {
    url: 'https://example.org/a',
    title: 'A',
    content: '',
    offset: 5000,
    truncated: false
  };
  const call = { toolId: 'read_url', toolDef: { id: 'read_url' }, result };
  // Today's bug, kept as the reason for the declared outcome: the source says ok.
  assert.equal(extractToolSources(call).items[0].read.ok, true);
  assert.equal(extractToolOutcome(call).readOutcome, 'empty');
});

// ── result count and read outcome, declared by the server ───────────────────

const outcome = (toolId, result, extra = {}) =>
  extractToolOutcome({ toolId, toolDef: { id: toolId }, result, ...extra });

test('a web search declares how many hits it returned, zero included', () => {
  assert.deepEqual(
    outcome('braveSearch', {
      results: [{ url: 'https://a.example/' }, { url: 'https://b.example/' }]
    }),
    {
      resultCount: 2
    }
  );
  assert.deepEqual(outcome('braveSearch', { results: [] }), { resultCount: 0 });
  assert.deepEqual(outcome('braveSearch', [{ url: 'https://a.example/' }]), { resultCount: 1 });
});

test('a search that did not say, or failed, declares nothing (never "no results")', () => {
  assert.deepEqual(outcome('braveSearch', { answer: 'text only' }), {});
  assert.deepEqual(outcome('braveSearch', 'plain text'), {});
  assert.deepEqual(outcome('braveSearch', { error: true }), {});
  assert.deepEqual(outcome('braveSearch', { results: [] }, { failed: true }), {});
  // An unclassified tool has no producer: unknown.
  assert.deepEqual(outcome('create_pdf', { results: [] }), {});
});

test('a read declares whether it delivered text; an offset at the end of a page did not', () => {
  const page = { url: 'https://example.org/a', title: 'A', truncated: false };
  assert.deepEqual(outcome('read_url', { ...page, content: 'words here' }), {
    readOutcome: 'opened'
  });
  // `sliceDocument` clamps `offset` to the end and returns no content, and the
  // page source still says `read.ok`: the declared outcome is what counts.
  assert.deepEqual(outcome('read_url', { ...page, content: '  ', offset: 5000 }), {
    readOutcome: 'empty'
  });
  assert.deepEqual(outcome('read_url', { error: true }, { failed: true }), {});
});

test('a project search counts its passages only when every project answered', () => {
  const search = (extra = {}) =>
    outcome('knowledge_search', {
      hits: [],
      unavailable: [],
      retrieval: { mode: 'search' },
      ...extra
    });
  assert.deepEqual(search(), { resultCount: 0 });
  assert.deepEqual(search({ hits: [{ n: 1 }, { n: 2 }] }), { resultCount: 2 });
  // "No project is available" and an unavailable project are not "no results".
  assert.deepEqual(outcome('knowledge_search', { hits: [], note: 'No project is available' }), {});
  assert.deepEqual(search({ unavailable: [{ project: 'p' }] }), {});
  assert.deepEqual(outcome('knowledge_read', { content: 'text' }), { readOutcome: 'opened' });
  assert.deepEqual(outcome('knowledge_read', { content: '' }), { readOutcome: 'empty' });
  assert.deepEqual(outcome('knowledge_list', { documents: [] }), {});
});

test('an iFinder search and a document read declare theirs', () => {
  assert.deepEqual(outcome('iFinder_search', { results: [] }), { resultCount: 0 });
  assert.deepEqual(outcome('iFinder_search', { results: [{ id: '1' }] }), { resultCount: 1 });
  assert.deepEqual(outcome('iFinder_getContent', { documentId: '1', content: 'x' }), {
    readOutcome: 'opened'
  });
});

// ── the answer basis ─────────────────────────────────────────────────────────

const seam = (toolId, toolDef, out) => {
  const added = [];
  knowledgeSourceSeam.postTool(
    { addKnowledgeSource: source => added.push(source), addIntegration: () => {} },
    { toolId, toolDef },
    out
  );
  return added;
};

test('a read_url that opened nothing does not make the answer web based', () => {
  assert.deepEqual(seam('read_url', { id: 'read_url' }, { readOutcome: 'empty' }), []);
  assert.deepEqual(seam('read_url', { id: 'read_url' }, { error: new Error('x') }), []);
  assert.deepEqual(seam('read_url', { id: 'read_url' }, {}), []);
  assert.deepEqual(seam('read_url', { id: 'read_url' }, { readOutcome: 'opened' }), ['websearch']);
});

test('recalling earlier sources names the origin they came from, when it is one place', () => {
  const recall = items => {
    const out = { sources: { items } };
    seam('chat_sources_read', { id: 'chat_sources_read' }, out);
    return out.activityOrigin;
  };
  assert.equal(recall([{ provider: 'web' }, { provider: 'web' }]), 'web');
  assert.equal(recall([{ provider: 'project' }]), 'project');
  assert.equal(recall([{ provider: 'web' }, { provider: 'project' }]), undefined);
  assert.equal(recall([]), undefined);
});

// ── Source.origin ───────────────────────────────────────────────────────────

test('web, project, iFinder and connected-system sources carry the call’s origin', () => {
  const web = extractToolSources({
    toolId: 'braveSearch',
    toolDef: { id: 'braveSearch' },
    result: { results: [{ url: 'https://a.example/', title: 'A' }] }
  });
  assert.deepEqual(web.items[0].origin, { kind: 'web' });
  const doc = extractToolSources({
    toolId: 'iFinder_search',
    toolDef: { id: 'iFinder_search' },
    args: { query: 'q' },
    result: { searchProfile: 'p', results: [{ id: 'd1', title: 'Doc' }] }
  });
  assert.deepEqual(doc.items[0].origin, { kind: 'ifinder' });
  const jira = extractToolSources({
    toolId: 'jira_find',
    toolDef: {
      id: 'jira_find',
      _integration: { definition: 'com.intrafind/jira', instanceLabel: 'Jira' }
    },
    result: { sources: [{ id: 'ACME-1', title: 'Login fails' }] }
  });
  assert.deepEqual(jira.items[0].origin, { kind: 'integration', label: 'Jira' });
});

test('an MCP tool named like a web search is a connected system, and so are its sources', () => {
  const frame = extractToolSources({
    toolId: 'mcp_x__web_search',
    toolDef: { id: 'mcp_x__web_search', _mcp: { serverId: 'x', originalName: 'web_search' } },
    result: { results: [{ url: 'https://a.example/' }] }
  });
  assert.equal(frame.items[0].origin.kind, 'integration');
});

test('provider-run web search reports web sources', () => {
  const frame = sourcesFromGrounding({
    searchResults: [{ url: 'https://a.example/', title: 'A' }]
  });
  assert.deepEqual(normalizeSource(frame.items[0]).origin, { kind: 'web' });
});

test('an origin is a known kind; only an integration carries a label; the first sighting wins', () => {
  const base = { provider: 'p', id: 'x', title: 't' };
  assert.deepEqual(
    normalizeSource({ ...base, origin: { kind: 'project', label: 'Secret' } }).origin,
    {
      kind: 'project'
    }
  );
  assert.equal(normalizeSource({ ...base, origin: { kind: 'made-up' } }).origin, undefined);
  assert.equal(normalizeSource(base).origin, undefined, 'nothing is inferred from the provider');
  const a = normalizeSource({ ...base, origin: { kind: 'web' } });
  const b = normalizeSource({ ...base, origin: { kind: 'project' } });
  assert.deepEqual(mergeSource(a, b).origin, { kind: 'web' });
});

// ── the wire and the run state ───────────────────────────────────────────────

test('the origin rides on tool/started, the args frames and tool/completed', () => {
  const state = reduceRunEvents(createStreamState(), [
    env(1, 'run/started', { kind: 'chat' }),
    env(2, 'tool/progress', {
      step: 0,
      callId: 'a',
      toolId: 'knowledge_search',
      phase: 'args',
      data: {
        name: 'knowledge_search',
        activityKind: 'search',
        activityOrigin: 'project',
        argBytes: 5
      }
    }),
    env(3, 'tool/started', {
      step: 0,
      callId: 'a',
      toolId: 'knowledge_search',
      name: 'knowledge_search',
      activityKind: 'search',
      activityScope: 'documents',
      activityOrigin: 'project',
      args: { query: 'iFinder6' }
    }),
    env(4, 'tool/completed', {
      step: 0,
      callId: 'a',
      toolId: 'knowledge_search',
      name: 'knowledge_search',
      resultCount: 0
    }),
    env(5, 'tool/progress', {
      step: 0,
      callId: 'b',
      toolId: 'read_url',
      phase: 'args',
      data: { name: 'read_url', activityKind: 'fetch', activityOrigin: 'web', argBytes: 5 }
    }),
    env(6, 'tool/started', {
      step: 0,
      callId: 'b',
      toolId: 'read_url',
      name: 'read_url',
      activityKind: 'fetch',
      activityOrigin: 'web',
      args: { url: 'https://a.example/', offset: 9999 }
    }),
    env(7, 'tool/completed', {
      step: 0,
      callId: 'b',
      toolId: 'read_url',
      name: 'read_url',
      readOutcome: 'empty'
    }),
    env(8, 'tool/started', {
      step: 0,
      callId: 'c',
      toolId: 'odd',
      name: 'odd',
      activityKind: 'search',
      activityOrigin: 'not-an-origin',
      args: {}
    }),
    env(9, 'tool/completed', { step: 0, callId: 'c', toolId: 'odd', name: 'odd', resultCount: -3 }),
    env(10, 'run/ended', { status: 'completed' })
  ]);
  const { items } = buildToolActivity(getRun(state, 'r1'));
  const [project, page, odd] = items;
  assert.equal(project.origin, 'project');
  assert.equal(project.resultCount, 0, 'declared zero, not an empty list');
  assert.equal(project.readOutcome, null);
  assert.equal(page.origin, 'web');
  assert.equal(page.readOutcome, 'empty');
  assert.equal(page.resultCount, null);
  assert.equal(odd.origin, null, 'an origin the client does not know is not drawn');
  assert.equal(odd.resultCount, null, 'an invalid count is not a count');
});

test('a call from an older server has no origin, count or outcome, and nothing is guessed', () => {
  const state = reduceRunEvents(createStreamState(), [
    env(1, 'run/started', { kind: 'chat' }),
    env(2, 'tool/started', {
      step: 0,
      callId: 'a',
      toolId: 'braveSearch',
      name: 'braveSearch',
      activityKind: 'search',
      activityScope: 'web',
      args: { query: 'q' }
    }),
    env(3, 'tool/completed', { step: 0, callId: 'a', toolId: 'braveSearch', name: 'braveSearch' }),
    env(4, 'run/ended', { status: 'completed' })
  ]);
  const [item] = buildToolActivity(getRun(state, 'r1')).items;
  assert.equal(item.origin, null);
  assert.equal(item.resultCount, null);
  assert.equal(item.readOutcome, null);
});

test('the provider-run search row is the web', () => {
  const state = reduceRunEvents(createStreamState(), [
    env(1, 'run/started', { kind: 'chat' }),
    env(2, 'tool/progress', { step: 0, phase: 'grounding', data: { webSearchQueries: ['q'] } }),
    env(3, 'run/ended', { status: 'completed' })
  ]);
  const native = buildToolActivity(getRun(state, 'r1')).items.find(item => item.native);
  assert.equal(native.origin, 'web');
  assert.equal(native.resultCount, null, 'a provider-run search declares no count');
});

// ── skills ──────────────────────────────────────────────────────────────────

test('a skill keeps the earliest, most explicit route: user, app, model, then an earlier message', () => {
  const fold = (...by) =>
    by.reduce(
      (skills, activatedBy) => foldSkill(skills, { name: 's', description: '', activatedBy }),
      []
    )[0].activatedBy;
  assert.equal(fold('model', 'user'), 'user');
  assert.equal(fold('user', 'model'), 'user');
  assert.equal(fold('model', 'app'), 'app');
  assert.equal(fold('app', 'model'), 'app');
  assert.equal(fold('chat', 'model'), 'model');
  assert.equal(fold('model', 'chat'), 'model');
  assert.equal(fold('chat'), 'chat');
});

test('the reducer and the activity rows keep app and chat as who brought a skill in', () => {
  const frame = (seq, name, activatedBy) =>
    env(seq, 'tool/progress', {
      phase: 'skill.activation',
      message: name,
      data: { skillName: name, skillId: name, activatedBy, description: '' }
    });
  const state = reduceRunEvents(createStreamState(), [
    env(1, 'run/started', { kind: 'chat' }),
    frame(2, 'a', 'app'),
    frame(3, 'b', 'chat'),
    frame(4, 'c', 'somebody'),
    env(5, 'run/ended', { status: 'completed' })
  ]);
  const run = getRun(state, 'r1');
  assert.deepEqual(
    run.skills.map(skill => skill.activatedBy),
    ['app', 'chat', undefined]
  );
  assert.deepEqual(
    buildToolActivity(run).items.map(item => item.activatedBy),
    ['app', 'chat', null]
  );
});

// ── stored and shared activity ──────────────────────────────────────────────

const item = extra => ({
  id: 'c1',
  kind: 'search',
  toolId: 'braveSearch',
  name: 'braveSearch',
  status: 'completed',
  scope: 'web',
  query: 'q',
  details: [],
  sources: [],
  ...extra
});

test('a stored chat keeps the origin, the declared count and outcome, and the provider', () => {
  const stored = boundStoredActivity({
    toolActivity: {
      items: [
        item({ integration: 'Brave Search', origin: 'web', resultCount: 5 }),
        item({ id: 'c2', kind: 'fetch', origin: 'web', readOutcome: 'empty' }),
        item({ id: 'c3', origin: 'nowhere', resultCount: -1, readOutcome: 'maybe' })
      ]
    },
    activeSkills: [
      { name: 'a', activatedBy: 'app' },
      { name: 'b', activatedBy: 'chat' }
    ]
  });
  const [web, read, junk] = stored.toolActivity.items;
  assert.equal(web.integration, 'Brave Search');
  assert.equal(web.origin, 'web');
  assert.equal(web.resultCount, 5);
  assert.equal(read.readOutcome, 'empty');
  assert.equal(junk.origin, undefined);
  assert.equal(junk.resultCount, undefined);
  assert.equal(junk.readOutcome, undefined);
  assert.deepEqual(
    stored.activeSkills.map(skill => skill.activatedBy),
    ['app', 'chat']
  );
});

test('a stored source keeps its origin; only an integration keeps a label', () => {
  const stored = boundStoredActivity({
    toolActivity: {
      items: [
        item({
          sources: [
            { id: 'a', provider: 'web', kind: 'page', origin: { kind: 'web', label: 'x' } },
            {
              id: 'b',
              provider: 'jira',
              kind: 'item',
              origin: { kind: 'integration', label: 'Jira' }
            }
          ]
        })
      ]
    }
  });
  assert.deepEqual(
    stored.toolActivity.items[0].sources.map(source => source.origin),
    [{ kind: 'web' }, { kind: 'integration', label: 'Jira' }]
  );
});

test('a share carries the origin type, never the name of what was searched', () => {
  const shared = shareableActivity(
    boundStoredActivity({
      toolActivity: {
        items: [
          item({
            id: 'p',
            toolId: 'knowledge_search',
            origin: 'project',
            resultCount: 0,
            scope: 'documents',
            integration: 'Project Alpha'
          }),
          item({
            id: 'j',
            toolId: 'jira_find',
            origin: 'integration',
            integration: 'Jira',
            resultCount: 3
          }),
          item({ id: 'r', kind: 'fetch', toolId: 'read_url', origin: 'web', readOutcome: 'empty' }),
          item({ id: 'w', origin: 'web', integration: 'Brave Search', resultCount: 5 })
        ]
      }
    })
  );
  const byId = Object.fromEntries(shared.toolActivity.items.map(entry => [entry.id, entry]));
  assert.equal(byId.p.origin, 'project');
  assert.equal(byId.p.resultCount, 0);
  assert.equal(byId.j.origin, 'integration');
  assert.equal(byId.r.readOutcome, 'empty');
  for (const id of ['p', 'j', 'r']) {
    assert.equal(byId[id].integration, undefined, `no system name on the private call ${id}`);
  }
  // A public web search is shared whole, provider included.
  assert.equal(byId.w.integration, 'Brave Search');
  assert.equal(byId.w.origin, 'web');
});

// ── review findings: origin is the server's, from the call ────────────────

test('what a tool reports as the origin of its sources is not believed; the call’s origin is applied', () => {
  const claimsWeb = { sources: [{ id: 'x1', title: 'Hit', origin: { kind: 'web' } }] };
  const mcp = extractToolSources({
    toolId: 'mcp_x__find',
    toolDef: { id: 'mcp_x__find', _mcp: { serverId: 'x', originalName: 'find' } },
    result: claimsWeb
  });
  assert.equal(mcp.items[0].origin.kind, 'integration');
  const claimsOther = extractToolSources({
    toolId: 'jira_find',
    toolDef: {
      id: 'jira_find',
      _integration: { definition: 'com.intrafind/jira', instanceLabel: 'Jira' }
    },
    result: {
      sources: [{ id: 'a', title: 'A', origin: { kind: 'integration', label: 'SharePoint' } }]
    }
  });
  assert.deepEqual(claimsOther.items[0].origin, { kind: 'integration', label: 'Jira' });
  // A tool the server cannot place gets no origin, whatever it claims.
  const unplaced = extractToolSources({
    toolId: 'create_report',
    toolDef: { id: 'create_report' },
    result: claimsWeb
  });
  assert.equal(unplaced.items[0].origin, undefined);
});

test('the recall of earlier sources keeps the origin they were stored with', () => {
  const frame = extractToolSources({
    toolId: 'chat_sources_read',
    toolDef: { id: 'chat_sources_read' },
    result: {
      sources: [
        {
          id: 'jira:1',
          provider: 'jira__search_issues',
          title: 'T',
          origin: { kind: 'integration', label: 'Jira' }
        }
      ]
    }
  });
  assert.deepEqual(frame.items[0].origin, { kind: 'integration', label: 'Jira' });
});

test('a recall is placed by the origin of its sources, and by the provider only for older ones', () => {
  const recall = items => {
    const out = { sources: { items } };
    seam('chat_sources_read', { id: 'chat_sources_read' }, out);
    return out.activityOrigin;
  };
  // An integration action's provider is its tool id: the id heuristic must not decide.
  assert.equal(
    recall([
      { provider: 'jira__search_issues', origin: { kind: 'integration', label: 'Jira' } },
      { provider: 'jira__search_issues', origin: { kind: 'integration', label: 'Jira' } }
    ]),
    'integration'
  );
  // Stored before origins existed: the provider it was found with.
  assert.equal(recall([{ provider: 'web' }]), 'web');
  assert.equal(recall([{ provider: 'project' }]), 'project');
  // Several places: none.
  assert.equal(
    recall([
      { provider: 'web', origin: { kind: 'web' } },
      { provider: 'x', origin: { kind: 'project' } }
    ]),
    undefined
  );
});
