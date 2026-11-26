#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `websearch.provider` → web search engine.
 *
 * Every engine is an installation of type `web-search` (Brave, Staan,
 * or a third party's). `auto` takes the first engine that is enabled and that
 * the user's groups grant, in the order Brave, Staan, then any other
 * engine by id; a named engine is that one or nothing — it never falls back to
 * another engine, so an app set to one engine does not silently answer from
 * another. No engine means no tool-based search; native search does not need
 * one (see websearch-installation-access.test.js).
 *
 * Run: node --test server/tests/websearch-provider-selection.test.js
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { loadTools } from '../services/tools/catalog.js';
import {
  describeWebSearchAvailability,
  isWebSearchAvailableTo,
  resolveWebSearchEngine,
  resolveWebSearchEngineToolId
} from '../services/tools/webSearchResolver.js';
import { BUILT_IN_ENGINES, sortWebSearchEngines } from '../services/search/webSearchEngines.js';
import {
  RESEARCHER,
  STAFF,
  engine,
  grantResearchOnly,
  setUpWebSearch,
  tearDownWebSearch,
  useWebSearch
} from './helpers/webSearchEngines.js';

const idOf = (provider, options) => resolveWebSearchEngine(provider, options)?.id ?? null;

let savedKeys;
before(async () => {
  await setUpWebSearch();
  savedKeys = { brave: process.env.BRAVE_SEARCH_API_KEY, staan: process.env.STAAN_API_KEY };
});
beforeEach(() => {
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.STAAN_API_KEY;
});
after(async () => {
  for (const [name, value] of [
    ['BRAVE_SEARCH_API_KEY', savedKeys.brave],
    ['STAAN_API_KEY', savedKeys.staan]
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await tearDownWebSearch();
});

describe('auto', () => {
  it('takes Brave, then Staan, then any other engine, whatever order they are installed in', () => {
    useWebSearch({ installed: [engine('acme'), engine('staan'), engine('brave')] });
    assert.equal(idOf('auto', { user: STAFF }), 'brave');
    useWebSearch({ installed: [engine('acme'), engine('staan')] });
    assert.equal(idOf('auto', { user: STAFF }), 'staan');
    useWebSearch({ installed: [engine('acme')] });
    assert.equal(idOf('auto', { user: STAFF }), 'acme');
  });

  it('takes SearXNG after the other built-ins, and alone when it is the only engine', async () => {
    useWebSearch({ installed: [engine('searxng'), engine('staan')] });
    assert.equal(idOf('auto', { user: STAFF }), 'staan');
    useWebSearch({ installed: [engine('searxng', { values: { instanceUrl: 'http://s:8080' } })] });
    assert.equal(idOf('auto', { user: STAFF }), 'searxng');
    assert.equal(idOf('searxng', { user: STAFF }), 'searxng');
    assert.equal(await resolveWebSearchEngineToolId('searxng', { user: STAFF }), 'searxngSearch');
  });

  it('does not offer SearXNG as available until its URL is set', async () => {
    useWebSearch({ installed: [engine('searxng')] });
    const available = await describeWebSearchAvailability(
      { id: 'a', websearch: { enabled: true, provider: 'searxng' } },
      STAFF
    );
    assert.equal(available.script, false);
    useWebSearch({ installed: [engine('searxng', { values: { instanceUrl: 'http://s:8080' } })] });
    const ready = await describeWebSearchAvailability(
      { id: 'a', websearch: { enabled: true, provider: 'searxng' } },
      STAFF
    );
    assert.equal(ready.script, true);
  });

  it('treats a missing provider value as auto', () => {
    useWebSearch({ installed: [engine('staan')] });
    assert.equal(idOf(undefined, { user: STAFF }), 'staan');
    assert.equal(idOf('', { user: STAFF }), 'staan');
  });

  it('passes over a disabled engine', () => {
    useWebSearch({
      installed: [engine('brave', { enabled: false }), engine('staan'), engine('acme')]
    });
    assert.equal(idOf('auto', { user: STAFF }), 'staan');
  });

  it('passes over an engine the user’s groups do not grant', () => {
    useWebSearch({
      installed: [engine('brave'), engine('staan'), engine('acme')],
      groups: grantResearchOnly('acme', 'staan')
    });
    assert.equal(idOf('auto', { user: RESEARCHER }), 'staan');
    assert.equal(idOf('auto', { user: STAFF }), null);
    assert.equal(idOf('auto'), null, 'anonymous gets nothing here');
  });

  it('accepts the installation, definition and type grants', () => {
    const installed = [engine('brave'), engine('staan'), engine('acme')];
    for (const [key, expected] of [
      ['acme', 'acme'],
      ['com.intrafind/staan-search', 'staan'],
      ['type:web-search', 'brave'],
      ['*', 'brave']
    ]) {
      useWebSearch({ installed, groups: grantResearchOnly(key) });
      assert.equal(idOf('auto', { user: RESEARCHER }), expected, key);
    }
  });

  it('takes a third-party engine after the built-ins, by id', () => {
    useWebSearch({ installed: [engine('zeta'), engine('acme'), engine('staan')] });
    assert.equal(idOf('auto', { user: STAFF }), 'staan');
    useWebSearch({
      installed: [engine('zeta'), engine('acme'), engine('staan', { enabled: false })]
    });
    assert.equal(idOf('auto', { user: STAFF }), 'acme');
  });

  it('is nothing while no engine is installed', () => {
    useWebSearch({
      installed: [
        { id: 'jira', definition: 'com.intrafind/jira', definitionVersion: '1.0.0', enabled: true }
      ]
    });
    assert.equal(idOf('auto', { user: STAFF }), null);
    assert.equal(isWebSearchAvailableTo(STAFF), false);
  });

  it('with the loaded tools, passes over an engine whose search action is off', async () => {
    useWebSearch({
      installed: [
        engine('brave', { actions: { enabled: ['*'], disabled: ['search'] } }),
        engine('staan')
      ]
    });
    const tools = await loadTools('en');
    assert.equal(idOf('auto', { user: STAFF }), 'brave');
    assert.equal(idOf('auto', { user: STAFF, tools }), 'staan');
    assert.equal(await resolveWebSearchEngineToolId('auto', { user: STAFF }), 'staanSearch');
  });
});

describe('a named engine', () => {
  it('is that engine', () => {
    useWebSearch({ installed: [engine('brave'), engine('staan'), engine('acme')] });
    for (const id of ['brave', 'staan', 'acme']) assert.equal(idOf(id, { user: STAFF }), id);
  });

  it('is nothing when missing, disabled or not granted — never another engine', () => {
    useWebSearch({ installed: [engine('staan')] });
    assert.equal(idOf('brave', { user: STAFF }), null);
    useWebSearch({ installed: [engine('brave', { enabled: false }), engine('staan')] });
    assert.equal(idOf('brave', { user: STAFF }), null);
    useWebSearch({
      installed: [engine('brave'), engine('staan')],
      groups: grantResearchOnly('staan')
    });
    assert.equal(idOf('brave', { user: RESEARCHER }), null);
    assert.equal(isWebSearchAvailableTo(RESEARCHER, 'brave'), false);
    assert.equal(isWebSearchAvailableTo(RESEARCHER, 'staan'), true);
  });

  it('is nothing when the id is an installation that is no engine', () => {
    useWebSearch({
      installed: [
        { id: 'jira', definition: 'com.intrafind/jira', definitionVersion: '1.0.0', enabled: true },
        engine('staan')
      ]
    });
    assert.equal(idOf('jira', { user: STAFF }), null);
  });

  it('can be a third-party engine', async () => {
    useWebSearch({
      installed: [engine('acme'), engine('staan')]
    });
    assert.equal(idOf('acme', { user: STAFF }), 'acme');
    assert.equal(await resolveWebSearchEngineToolId('acme', { user: STAFF }), 'acme__search');
  });
});

describe('describeWebSearchAvailability', () => {
  const app = provider => ({ id: 'a', websearch: { enabled: true, provider } });

  it('is null for an app without web search', async () => {
    assert.equal(await describeWebSearchAvailability({ id: 'a' }, STAFF), null);
  });

  it('lists the native providers and whether an engine works', async () => {
    useWebSearch({ installed: [] });
    assert.deepEqual(await describeWebSearchAvailability(app('auto'), STAFF), {
      native: ['google', 'openai-responses', 'anthropic'],
      script: false
    });
    useWebSearch({ installed: [engine('acme')] });
    assert.equal((await describeWebSearchAvailability(app('auto'), STAFF)).script, true);
    assert.equal((await describeWebSearchAvailability(app('brave'), STAFF)).script, false);
  });

  it('needs a key for Brave and Staan, from the credential or the environment', async () => {
    useWebSearch({ installed: [engine('brave')] });
    assert.equal((await describeWebSearchAvailability(app('auto'), STAFF)).script, false);
    process.env.BRAVE_SEARCH_API_KEY = 'from-env';
    assert.equal((await describeWebSearchAvailability(app('auto'), STAFF)).script, true);
  });

  it('follows the user’s grant', async () => {
    useWebSearch({ installed: [engine('acme')], groups: grantResearchOnly('acme') });
    assert.equal((await describeWebSearchAvailability(app('auto'), RESEARCHER)).script, true);
    assert.equal((await describeWebSearchAvailability(app('auto'), STAFF)).script, false);
  });

  it('lists no native provider when the app turned native search off', async () => {
    useWebSearch({ installed: [] });
    const off = { id: 'a', websearch: { enabled: true, useNativeSearch: false } };
    assert.deepEqual((await describeWebSearchAvailability(off, STAFF)).native, []);
  });
});

describe('sortWebSearchEngines', () => {
  it('puts the built-ins first in their order, then the others by id', () => {
    const sorted = sortWebSearchEngines(['zeta', 'acme', 'staan', 'brave'].map(id => ({ id })));
    assert.deepEqual(
      sorted.map(e => e.id),
      ['brave', 'staan', 'acme', 'zeta']
    );
    assert.deepEqual(
      sortWebSearchEngines(['acme', 'searxng', 'staan', 'brave'].map(id => ({ id }))).map(
        e => e.id
      ),
      ['brave', 'staan', 'searxng', 'acme']
    );
  });

  it('names a tool and a definition for every built-in engine', () => {
    assert.deepEqual(
      BUILT_IN_ENGINES.map(e => [e.id, e.toolId, e.definition]),
      [
        ['brave', 'braveSearch', 'com.intrafind/brave-search'],
        ['staan', 'staanSearch', 'com.intrafind/staan-search'],
        ['searxng', 'searxngSearch', 'com.intrafind/searxng-search']
      ]
    );
  });
});
