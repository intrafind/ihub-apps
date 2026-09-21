#!/usr/bin/env node

/**
 * Brave search provider specs — the request path, which had none.
 *
 * Brave was the only provider that called `throttledFetch` directly, so nothing
 * about the request it builds or how it reacts to a refusal was covered. That
 * mattered once this branch started sending `search_lang` / `country`: Brave
 * validates both, no Brave API key exists in CI, and the values are only
 * documented in Brave's own client. So the one path that could regress a
 * working install was also the one path no test touched.
 *
 * The provider now takes an injectable `fetchImpl`, like Qwant and Staan, and
 * these specs drive it against canned responses.
 *
 * Run: node --test server/tests/brave-search-provider.test.js
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { BraveSearchProvider } from '../services/WebSearchService.js';
import { _clearSearchCache } from '../services/searchCache.js';

/** A fetch-style Response over a canned JSON body. */
function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

/** A successful Brave web payload. */
function webPayload(n = 2) {
  return {
    web: {
      results: Array.from({ length: n }, (_, i) => ({
        title: `title ${i}`,
        url: `https://example.com/${i}`,
        description: `description ${i}`,
        language: 'en'
      }))
    }
  };
}

function recordingFetch(responses) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** A provider wired to canned responses, a fixed key and a fixed language. */
function makeProvider(responses, { language = 'en' } = {}) {
  const fetchImpl = recordingFetch(responses);
  const provider = new BraveSearchProvider({
    fetchImpl,
    languageResolver: requested => requested || language
  });
  // The key normally comes from providers.json / env; neither exists in CI.
  provider.getApiKey = () => 'test-key';
  return { provider, fetchImpl };
}

const paramsOf = url => new URL(url).searchParams;

describe('BraveSearchProvider — request', () => {
  beforeEach(() => _clearSearchCache());

  it('sends the subscription token and asks for JSON', async () => {
    const { provider, fetchImpl } = makeProvider(jsonResponse(webPayload()));
    await provider.search('test');
    assert.equal(fetchImpl.calls[0].options.headers['X-Subscription-Token'], 'test-key');
    assert.equal(fetchImpl.calls[0].options.headers.Accept, 'application/json');
  });

  it('targets the language Brave knows', async () => {
    const { provider, fetchImpl } = makeProvider(jsonResponse(webPayload()), { language: 'de-DE' });
    await provider.search('test');
    const p = paramsOf(fetchImpl.calls[0].url);
    assert.equal(p.get('q'), 'test');
    assert.equal(p.get('search_lang'), 'de');
    assert.equal(p.get('country'), 'DE');
  });

  it('sends no language parameters for a language Brave does not serve', async () => {
    // Which is exactly how Brave search behaved before language targeting existed.
    const { provider, fetchImpl } = makeProvider(jsonResponse(webPayload()), { language: 'el' });
    await provider.search('test');
    const p = paramsOf(fetchImpl.calls[0].url);
    assert.equal(p.get('search_lang'), null);
    assert.equal(p.get('country'), null);
  });

  it('round-trips a query whose encoding differs between serializers', async () => {
    // URLSearchParams writes a space as `+`; Brave's own examples and client do
    // the same, so what matters is that the decoded query is unchanged.
    const { provider, fetchImpl } = makeProvider(jsonResponse(webPayload()));
    await provider.search('C++ "quoted" & 日本語');
    assert.equal(paramsOf(fetchImpl.calls[0].url).get('q'), 'C++ "quoted" & 日本語');
  });

  it('maps results onto the shape every provider returns', async () => {
    const { provider } = makeProvider(jsonResponse(webPayload(2)));
    const { results } = await provider.search('test');
    assert.equal(results.length, 2);
    assert.deepEqual(results[0], {
      title: 'title 0',
      url: 'https://example.com/0',
      description: 'description 0',
      language: 'en'
    });
  });
});

describe('BraveSearchProvider — refusal of the language parameters', () => {
  beforeEach(() => _clearSearchCache());

  for (const status of [400, 422]) {
    it(`drops the language and retries once on HTTP ${status}`, async () => {
      const { provider, fetchImpl } = makeProvider(
        [jsonResponse({ error: 'bad param' }, { status }), jsonResponse(webPayload(1))],
        { language: 'de-DE' }
      );

      const { results } = await provider.search('test');

      assert.equal(fetchImpl.calls.length, 2);
      assert.equal(paramsOf(fetchImpl.calls[0].url).get('search_lang'), 'de');
      // The retry is the same search without the targeting — not no search.
      assert.equal(paramsOf(fetchImpl.calls[1].url).get('search_lang'), null);
      assert.equal(paramsOf(fetchImpl.calls[1].url).get('country'), null);
      assert.equal(paramsOf(fetchImpl.calls[1].url).get('q'), 'test');
      assert.equal(results.length, 1);
    });
  }

  it('does not retry when there were no language parameters to drop', async () => {
    // Otherwise an ordinary bad request would silently cost a second call.
    const { provider, fetchImpl } = makeProvider(jsonResponse({ error: 'bad' }, { status: 400 }), {
      language: 'el'
    });
    await assert.rejects(provider.search('test'), /status 400/);
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('gives up rather than looping when the retry is refused too', async () => {
    const { provider, fetchImpl } = makeProvider(jsonResponse({ error: 'bad' }, { status: 400 }), {
      language: 'de'
    });
    await assert.rejects(provider.search('test'), error => {
      assert.equal(error.code, 'HTTP_400');
      return true;
    });
    assert.equal(fetchImpl.calls.length, 2);
  });

  it('caches the untargeted result under a key that says untargeted', async () => {
    // The key is recomputed when the params are dropped. Without that, a later
    // caller asking in German would be served this untargeted result from a key
    // claiming `search_lang=de`.
    const { provider, fetchImpl } = makeProvider(
      [jsonResponse({ error: 'bad param' }, { status: 422 }), jsonResponse(webPayload(1))],
      { language: 'de' }
    );
    await provider.search('test');
    const callsAfterFirst = fetchImpl.calls.length;

    // A caller that resolves to no language at all should hit that cached entry.
    const { provider: plain } = makeProvider(jsonResponse(webPayload(5)), { language: 'el' });
    plain.fetchImpl = fetchImpl;
    const { results } = await plain.search('test');

    assert.equal(fetchImpl.calls.length, callsAfterFirst, 'the untargeted entry was not reused');
    assert.equal(results.length, 1);
  });
});

describe('BraveSearchProvider — transient failures', () => {
  beforeEach(() => _clearSearchCache());

  it('retries a rate-limited request and succeeds', async () => {
    const { provider, fetchImpl } = makeProvider([
      jsonResponse({ error: 'slow down' }, { status: 429 }),
      jsonResponse(webPayload(1))
    ]);
    const { results } = await provider.search('test');
    assert.equal(fetchImpl.calls.length, 2);
    assert.equal(results.length, 1);
  });

  it('wraps a transport failure with its code intact', async () => {
    const networkError = new Error('fetch failed');
    networkError.code = 'ECONNREFUSED';
    const { provider } = makeProvider(networkError);
    await assert.rejects(provider.search('test'), error => {
      assert.equal(error.code, 'ECONNREFUSED');
      assert.match(error.message, /Brave search request failed/);
      return true;
    });
  });

  it('fails with a recognisable message when no key is configured', async () => {
    const { provider, fetchImpl } = makeProvider(jsonResponse(webPayload()));
    provider.getApiKey = () => undefined;
    await assert.rejects(provider.search('test'), /API key is not configured/i);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('serves a repeat query from the cache', async () => {
    const { provider, fetchImpl } = makeProvider(jsonResponse(webPayload(2)));
    await provider.search('test');
    await provider.search('test');
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('does not let two languages share one cache entry', async () => {
    const { provider, fetchImpl } = makeProvider(jsonResponse(webPayload(2)), { language: 'de' });
    await provider.search('test');
    await provider.search('test', { language: 'fr' });
    assert.equal(fetchImpl.calls.length, 2);
  });
});
