// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Instance names on activity rows (#3668, "Next"): the project or search
 * profile a call looked in. The server names it (`places`), beside the result
 * and not in it, bounded, and a share keeps only what an admin owns: a user's
 * project name is the owner's.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runToolCallScope,
  reportToolCallPlaces,
  reportToolCallSources
} from '../services/sources/toolCallScope.js';
import { projectPlace } from '../services/sources/producers/project.js';
import { boundStoredActivity, shareableActivity } from '../services/chat/runActivity.js';
import { sseV2EventSchema } from '../services/loop/contracts/sseV2.js';

const inScope = fn => {
  const places = [];
  runToolCallScope([], () => fn(), null, places);
  return places;
};

test('a call reports the places it looked in beside its result', () => {
  const places = inScope(() =>
    reportToolCallPlaces([
      { name: 'Project Alpha', ownership: 'user' },
      { name: 'HR handbook', ownership: 'admin' }
    ])
  );
  assert.deepEqual(places, [
    { name: 'Project Alpha', ownership: 'user' },
    { name: 'HR handbook', ownership: 'admin' }
  ]);
});

test('one call reports sources and places side by side, each into its own list', () => {
  const sources = [];
  const places = [];
  runToolCallScope(
    sources,
    () => {
      reportToolCallSources([{ id: 's1', title: 'Page' }]);
      reportToolCallPlaces([{ name: 'Project Alpha', ownership: 'admin' }]);
    },
    null,
    places
  );
  assert.deepEqual(sources, [{ id: 's1', title: 'Page' }]);
  assert.deepEqual(places, [{ name: 'Project Alpha', ownership: 'admin' }]);
});

test('a scope without a places list reports sources as before and ignores places', () => {
  const sources = [];
  runToolCallScope(sources, () => {
    reportToolCallSources([{ id: 's1' }]);
    reportToolCallPlaces([{ name: 'Ignored' }]);
  });
  assert.deepEqual(sources, [{ id: 's1' }]);
});

test('a place is bounded: trimmed name, a known ownership, no repeats, at most ten', () => {
  const places = inScope(() =>
    reportToolCallPlaces([
      { name: '  Padded  ', ownership: 'admin' },
      { name: 'Padded', ownership: 'admin' },
      { name: 'x'.repeat(500), ownership: 'someone' },
      { name: '' },
      { ownership: 'user' },
      null,
      ...Array.from({ length: 20 }, (_, n) => ({ name: `P${n}`, ownership: 'user' }))
    ])
  );
  assert.equal(places.length, 10);
  assert.deepEqual(places[0], { name: 'Padded', ownership: 'admin' });
  assert.equal(places[1].name.length, 120);
  assert.equal(places[1].ownership, undefined);
});

test('outside a tool call nothing is reported, and a non-list is ignored', () => {
  assert.doesNotThrow(() => reportToolCallPlaces([{ name: 'Alone' }]));
  assert.deepEqual(
    inScope(() => reportToolCallPlaces('not a list')),
    []
  );
});

test('a project is a place by its name in the default language, with its ownership', () => {
  assert.deepEqual(projectPlace({ id: 'p1', name: 'Plain', ownership: 'user' }), {
    name: 'Plain',
    ownership: 'user'
  });
  assert.deepEqual(projectPlace({ id: 'p2', name: { en: 'English', de: 'Deutsch' } }), {
    name: 'English'
  });
  assert.equal(projectPlace({ id: 'p3' }).name, 'p3');
  assert.equal(projectPlace(null), null);
});

const row = places => ({
  id: 't1',
  kind: 'search',
  toolId: 'knowledge_search',
  status: 'completed',
  origin: 'project',
  resultCount: 2,
  query: 'iFinder6',
  places,
  details: [],
  sources: []
});

test('the stored activity keeps the places, bounded', () => {
  const stored = boundStoredActivity({
    toolActivity: {
      items: [
        row([
          { name: 'Project Alpha', ownership: 'user' },
          { name: 'z'.repeat(500), ownership: 'bogus' },
          { name: '' }
        ])
      ]
    }
  });
  const [item] = stored.toolActivity.items;
  assert.equal(item.places.length, 2);
  assert.deepEqual(item.places[0], { name: 'Project Alpha', ownership: 'user' });
  assert.equal(item.places[1].name.length, 120);
  assert.equal(item.places[1].ownership, undefined);
});

test('a share keeps the names of what an admin owns and drops a user’s project', () => {
  const shared = shareableActivity(
    boundStoredActivity({
      toolActivity: {
        items: [
          row([
            { name: 'Project Alpha', ownership: 'user' },
            { name: 'HR handbook', ownership: 'admin' }
          ])
        ]
      }
    })
  );
  const [item] = shared.toolActivity.items;
  assert.deepEqual(item.places, [{ name: 'HR handbook', ownership: 'admin' }]);
  assert.equal(JSON.stringify(shared).includes('Project Alpha'), false);
  // The rest of the row is what a share carried before: type and counts.
  assert.equal(item.origin, 'project');
  assert.equal(item.resultCount, 2);
});

test('a share of a row that only names a user’s project carries no places', () => {
  const shared = shareableActivity(
    boundStoredActivity({
      toolActivity: { items: [row([{ name: 'Mine', ownership: 'user' }])] }
    })
  );
  assert.equal(shared.toolActivity.items[0].places, undefined);
});

test('a place without a known owner is never shared', () => {
  const shared = shareableActivity(
    boundStoredActivity({ toolActivity: { items: [row([{ name: 'Unknown owner' }])] } })
  );
  assert.equal(shared.toolActivity.items[0].places, undefined);
});

test('tool/completed carries the places on the wire', () => {
  const frame = {
    v: 2,
    seq: 3,
    runId: 'r1',
    ts: '2026-11-16T10:00:03.000Z',
    type: 'tool/completed',
    data: {
      step: 1,
      callId: 'c1',
      toolId: 'knowledge_search',
      name: 'knowledge_search',
      resultPreview: {},
      places: [{ name: 'Project Alpha', ownership: 'user' }]
    }
  };
  const parsed = sseV2EventSchema.parse(frame);
  assert.deepEqual(parsed.data.places, [{ name: 'Project Alpha', ownership: 'user' }]);
});
