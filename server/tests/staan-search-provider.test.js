#!/usr/bin/env node

/**
 * Staan search provider specs.
 *
 * The provider is built so this suite needs no network, no mock framework and
 * no module interception: request building and response parsing are pure
 * exported functions, and the class takes an injectable `fetchImpl` and
 * `apiKeyResolver`, so the whole search path — key handling, paging, cache,
 * retries, error mapping — runs against canned responses.
 *
 * The behaviour pinned down here is mostly the API's own hard constraints,
 * because each one is answered with an HTTP 400 rather than forgiven: `count`
 * must be exactly 10, `offset` must be a multiple of 10 up to 30, the domain
 * filters are POST-only and mutually exclusive, and an unsupported `market` is
 * rejected outright. All four were confirmed against the live API.
 *
 * Run: node --test server/tests/staan-search-provider.test.js
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  StaanSearchProvider,
  buildStaanRequest,
  clampCount,
  clampOffset,
  normalizeStaanDomains,
  parseStaanError,
  parseStaanWebResults,
  planStaanPages,
  resolveStaanMarket,
  STAAN_API_URL,
  STAAN_DEFAULT_MARKET,
  STAAN_MAX_OFFSET,
  STAAN_MAX_WEB_RESULTS,
  STAAN_PAGE_SIZE
} from '../services/search/staanProvider.js';
import { _clearSearchCache } from '../services/searchCache.js';

/** A fetch-style Response over a canned JSON body. */
function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: { get: name => lower[String(name).toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

/** A response whose body is not JSON at all (a proxy's HTML error page). */
function htmlResponse(status = 502) {
  return {
    ok: false,
    status,
    statusText: 'Bad Gateway',
    headers: { get: () => null },
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
    text: async () => '<html>proxy error</html>'
  };
}

/** A successful Staan web payload wrapping `results`. */
function webPayload(results) {
  return {
    search_id: 'abc123',
    query: { q: 'test', market: 'en-us', count: 10, offset: 0 },
    web: { results }
  };
}

/** `n` distinct results, numbered so paging assertions can tell pages apart. */
function fakeResults(n, prefix = 'r') {
  return Array.from({ length: n }, (_, i) => ({
    title: `${prefix} title ${i}`,
    url: `https://example.com/${prefix}${i}`,
    snippet: `${prefix} snippet ${i}`,
    display_url: `https://example.com/${prefix}${i}`,
    hostname: 'example.com'
  }));
}

/** Records every call so assertions can look at the URL, method and body sent. */
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

/**
 * A provider wired to canned responses and a fixed key, with retries made
 * instant. Pass `apiKey: null` for an install that has configured none.
 */
function makeProvider(responses, { apiKey = 'test-key', languageResolver } = {}) {
  const fetchImpl = recordingFetch(responses);
  const provider = new StaanSearchProvider({
    fetchImpl,
    apiKeyResolver: () => apiKey,
    ...(languageResolver ? { languageResolver } : {}),
    retryBackoffMs: 1
  });
  return { provider, fetchImpl };
}

describe('resolveStaanMarket', () => {
  it('expands a bare language tag to a supported market', () => {
    assert.equal(resolveStaanMarket('de'), 'de-de');
    assert.equal(resolveStaanMarket('fr'), 'fr-fr');
    assert.equal(resolveStaanMarket('en'), 'en-us');
  });

  it('accepts hyphen, underscore and mixed case forms of the same market', () => {
    assert.equal(resolveStaanMarket('en-GB'), 'en-gb');
    assert.equal(resolveStaanMarket('en_gb'), 'en-gb');
    assert.equal(resolveStaanMarket('EN_Gb'), 'en-gb');
  });

  it('falls back to the language default when the region is unsupported', () => {
    // Staan serves de-de but not de-ch.
    assert.equal(resolveStaanMarket('de-CH'), 'de-de');
    assert.equal(resolveStaanMarket('fr-BE'), 'fr-fr');
  });

  it('falls back to en-us for unknown, empty and non-string input', () => {
    assert.equal(resolveStaanMarket('xx'), STAAN_DEFAULT_MARKET);
    assert.equal(resolveStaanMarket('it-IT'), STAAN_DEFAULT_MARKET);
    assert.equal(resolveStaanMarket(''), STAAN_DEFAULT_MARKET);
    assert.equal(resolveStaanMarket(undefined), STAAN_DEFAULT_MARKET);
    assert.equal(resolveStaanMarket(42), STAAN_DEFAULT_MARKET);
  });

  it('does not inherit the API default of fr-fr', () => {
    // Staan itself defaults to the French market. Letting that through would
    // answer an English install's searches in French.
    assert.notEqual(STAAN_DEFAULT_MARKET, 'fr-fr');
  });
});

describe('normalizeStaanDomains', () => {
  it('strips scheme, www, port, path and case', () => {
    assert.deepEqual(normalizeStaanDomains(['https://WWW.Example.com:443/a/b?c=1']), [
      'example.com'
    ]);
  });

  it('accepts a bare string as a one-entry filter', () => {
    assert.deepEqual(normalizeStaanDomains('intrafind.com'), ['intrafind.com']);
  });

  it('de-duplicates and drops empty or non-string entries', () => {
    assert.deepEqual(normalizeStaanDomains(['a.com', 'https://a.com', '', null, 7, 'b.com']), [
      'a.com',
      'b.com'
    ]);
  });

  it('caps the filter at the ten domains the API accepts', () => {
    const many = Array.from({ length: 25 }, (_, i) => `d${i}.com`);
    assert.equal(normalizeStaanDomains(many).length, 10);
  });

  it('returns an empty list for missing input', () => {
    assert.deepEqual(normalizeStaanDomains(undefined), []);
    assert.deepEqual(normalizeStaanDomains([]), []);
  });
});

describe('clampOffset / clampCount / planStaanPages', () => {
  it('rounds an offset down onto the multiple-of-ten grid the API requires', () => {
    // Live API: "offset must be a factor of 10".
    assert.equal(clampOffset(0), 0);
    assert.equal(clampOffset(15), 10);
    assert.equal(clampOffset(9), 0);
    assert.equal(clampOffset(-5), 0);
    assert.equal(clampOffset('nonsense'), 0);
  });

  it('caps an offset at the largest page the API serves', () => {
    // Live API: "offset must not be greater than 30".
    assert.equal(clampOffset(100), STAAN_MAX_OFFSET);
  });

  it('caps a count at what four pages can deliver', () => {
    assert.equal(clampCount(5), 5);
    assert.equal(clampCount(500), STAAN_MAX_WEB_RESULTS);
    assert.equal(clampCount(0), 1);
    assert.equal(clampCount('nonsense'), STAAN_PAGE_SIZE);
  });

  it('plans one page for ten results or fewer, and one more per further ten', () => {
    assert.deepEqual(planStaanPages(1), [0]);
    assert.deepEqual(planStaanPages(10), [0]);
    assert.deepEqual(planStaanPages(11), [0, 10]);
    assert.deepEqual(planStaanPages(40), [0, 10, 20, 30]);
    assert.deepEqual(planStaanPages(999), [0, 10, 20, 30]);
  });
});

describe('buildStaanRequest', () => {
  const params = url => new URL(url).searchParams;

  it('GETs the documented endpoint with the query and market', () => {
    const { url, method, body } = buildStaanRequest({ query: 'foo & bar', market: 'de-de' });
    assert.equal(method, 'GET');
    assert.equal(body, undefined);
    assert.ok(url.startsWith(`${STAAN_API_URL}?`), url);
    assert.equal(params(url).get('q'), 'foo & bar');
    assert.equal(params(url).get('market'), 'de-de');
    assert.equal(params(url).get('offset'), '0');
  });

  it('never sends count, which the API fixes at ten', () => {
    // Live API: "count must be equal to 10" — sending anything else is a 400,
    // so the caller's limit is applied to the results instead of the request.
    assert.equal(params(buildStaanRequest({ query: 'x' }).url).get('count'), null);
  });

  it('puts the offset on the grid the API accepts', () => {
    assert.equal(params(buildStaanRequest({ query: 'x', offset: 17 }).url).get('offset'), '10');
    assert.equal(
      params(buildStaanRequest({ query: 'x', offset: 90 }).url).get('offset'),
      String(STAAN_MAX_OFFSET)
    );
  });

  it('trims a query to the documented maximum length', () => {
    const long = 'a'.repeat(900);
    assert.equal(params(buildStaanRequest({ query: long }).url).get('q').length, 400);
  });

  it('switches to POST with a JSON body when a domain filter is used', () => {
    // The API takes the array filters only on POST.
    const { url, method, body } = buildStaanRequest({
      query: 'enterprise search',
      includeDomains: ['https://intrafind.com/']
    });
    assert.equal(method, 'POST');
    assert.equal(url, STAAN_API_URL);
    assert.deepEqual(JSON.parse(body), {
      q: 'enterprise search',
      market: STAAN_DEFAULT_MARKET,
      offset: 0,
      include_domains: ['intrafind.com']
    });
  });

  it('sends exclude_domains when only that filter is given', () => {
    const { body } = buildStaanRequest({ query: 'x', excludeDomains: ['spam.example'] });
    assert.deepEqual(JSON.parse(body).exclude_domains, ['spam.example']);
  });

  it('prefers include over exclude rather than sending both', () => {
    // Live API: "include_domains cannot be used with exclude_domains". Sending
    // both fails the whole search, so the narrower intent wins.
    const { body } = buildStaanRequest({
      query: 'x',
      includeDomains: ['a.com'],
      excludeDomains: ['b.com']
    });
    const parsed = JSON.parse(body);
    assert.deepEqual(parsed.include_domains, ['a.com']);
    assert.equal(parsed.exclude_domains, undefined);
  });

  it('stays on GET when the domain filters are empty', () => {
    assert.equal(
      buildStaanRequest({ query: 'x', includeDomains: [], excludeDomains: [] }).method,
      'GET'
    );
  });

  it('honours an endpoint override', () => {
    const { url } = buildStaanRequest({ query: 'x', endpoint: 'https://staan.internal/v2/web' });
    assert.ok(url.startsWith('https://staan.internal/v2/web?'), url);
  });
});

describe('parseStaanError', () => {
  it('returns null for a successful response', () => {
    assert.equal(parseStaanError(webPayload(fakeResults(3)), 200), null);
  });

  it('maps a rejected key onto STAAN_UNAUTHORIZED', () => {
    // The API's own error shape, seen live with a bad bearer token.
    const error = parseStaanError(
      { code: 'INVALID_CREDENTIALS', message: 'Unknown API key or invalid secret' },
      401
    );
    assert.equal(error.code, 'STAAN_UNAUTHORIZED');
    assert.match(error.message, /Unknown API key/);
  });

  it('maps a missing Authorization header onto STAAN_UNAUTHORIZED too', () => {
    // The framework's shape, seen live with no header at all.
    const error = parseStaanError({ message: 'Unauthorized', statusCode: 401 }, 401);
    assert.equal(error.code, 'STAAN_UNAUTHORIZED');
  });

  it('joins the validation messages of a rejected request', () => {
    const error = parseStaanError(
      {
        message: ['offset must be a factor of 10', 'count must be equal to 10'],
        error: 'Bad Request',
        statusCode: 400
      },
      400
    );
    assert.equal(error.code, 'STAAN_BAD_REQUEST');
    assert.match(error.message, /offset must be a factor of 10; count must be equal to 10/);
  });

  it('maps rate limiting onto its own retryable code', () => {
    const error = parseStaanError({ message: 'Too Many Requests', statusCode: 429 }, 429);
    assert.equal(error.code, 'STAAN_RATE_LIMITED');
  });

  it('reports a non-JSON body rather than throwing on it', () => {
    const error = parseStaanError(null, 502);
    assert.equal(error.code, 'STAAN_INVALID_RESPONSE');
    assert.match(error.message, /HTTP 502/);
  });

  it('falls back to a generic API error for an unrecognised failure', () => {
    const error = parseStaanError({ message: 'boom', statusCode: 500 }, 500);
    assert.equal(error.code, 'STAAN_API_ERROR');
    assert.match(error.message, /boom/);
  });
});

describe('parseStaanWebResults', () => {
  it('maps Staan fields onto the shape every provider returns', () => {
    const [result] = parseStaanWebResults(
      webPayload([
        {
          title: 'IntraFind',
          url: 'https://intrafind.com/de',
          snippet: 'Enterprise search',
          display_url: 'https://intrafind.com/de',
          hostname: 'intrafind.com',
          favicon_url: 'https://example.com/f.png'
        }
      ])
    );
    // `snippet` is Staan's name for what the other providers call description;
    // renaming it here is what lets an app switch provider transparently.
    assert.deepEqual(result, {
      title: 'IntraFind',
      url: 'https://intrafind.com/de',
      description: 'Enterprise search',
      hostname: 'intrafind.com'
    });
  });

  it('drops entries without a usable url', () => {
    const results = parseStaanWebResults(
      webPayload([{ title: 'no url' }, { url: 42 }, { url: 'https://ok.example' }])
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].url, 'https://ok.example');
  });

  it('tolerates missing title, snippet and hostname', () => {
    const [result] = parseStaanWebResults(webPayload([{ url: 'https://ok.example' }]));
    assert.deepEqual(result, { title: '', url: 'https://ok.example', description: '' });
  });

  it('returns an empty array for a payload with no web block', () => {
    assert.deepEqual(parseStaanWebResults({}), []);
    assert.deepEqual(parseStaanWebResults({ web: {} }), []);
    assert.deepEqual(parseStaanWebResults(null), []);
  });
});

describe('StaanSearchProvider', () => {
  beforeEach(() => _clearSearchCache());

  it('is named staan and reports itself configured only with a key', () => {
    const { provider } = makeProvider(jsonResponse(webPayload([])));
    assert.equal(provider.getName(), 'staan');
    assert.equal(provider.isConfigured(), true);

    const { provider: keyless } = makeProvider(jsonResponse(webPayload([])), { apiKey: null });
    assert.equal(keyless.isConfigured(), false);
  });

  it('fails with a recognisable message when no key is configured', async () => {
    const { provider, fetchImpl } = makeProvider(jsonResponse(webPayload([])), { apiKey: null });
    await assert.rejects(provider.search('test'), /API key is not configured/i);
    // And without spending a request on a call that could only come back 401.
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('sends the key as a bearer token and asks for JSON', async () => {
    const { provider, fetchImpl } = makeProvider(jsonResponse(webPayload(fakeResults(3))));
    await provider.search('test');

    const { options } = fetchImpl.calls[0];
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.equal(options.headers.Accept, 'application/json');
    assert.equal(options.method, 'GET');
    // No body on GET, so no Content-Type either.
    assert.equal(options.headers['Content-Type'], undefined);
  });

  it('returns parsed results for a successful search', async () => {
    const { provider } = makeProvider(jsonResponse(webPayload(fakeResults(3))));
    const { results } = await provider.search('test');
    assert.equal(results.length, 3);
    assert.equal(results[0].url, 'https://example.com/r0');
    assert.equal(results[0].description, 'r snippet 0');
  });

  it('maps the requested language onto the market parameter', async () => {
    const { provider, fetchImpl } = makeProvider(jsonResponse(webPayload(fakeResults(1))));
    await provider.search('test', { language: 'de' });
    assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get('market'), 'de-de');
  });

  it("uses the install's configured language when the caller supplies none", async () => {
    // The workflow/agent path passes no language, and before this a German
    // install's research runs were silently answered from the US market.
    const { provider, fetchImpl } = makeProvider(jsonResponse(webPayload(fakeResults(1))), {
      languageResolver: () => 'de'
    });
    await provider.search('test');
    assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get('market'), 'de-de');
  });

  it("the user's language still beats the install default", async () => {
    const { provider, fetchImpl } = makeProvider(jsonResponse(webPayload(fakeResults(1))), {
      languageResolver: language => language || 'de'
    });
    await provider.search('test', { language: 'en-GB' });
    assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get('market'), 'en-gb');
  });

  it('truncates the results to the requested count', async () => {
    const { provider } = makeProvider(jsonResponse(webPayload(fakeResults(10))));
    const { results } = await provider.search('test', { count: 3 });
    assert.equal(results.length, 3);
  });

  it('issues one request for ten results or fewer', async () => {
    const { provider, fetchImpl } = makeProvider(jsonResponse(webPayload(fakeResults(10))));
    await provider.search('test', { count: 10 });
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('pages with further requests when more than ten results are asked for', async () => {
    const { provider, fetchImpl } = makeProvider([
      jsonResponse(webPayload(fakeResults(10, 'a'))),
      jsonResponse(webPayload(fakeResults(10, 'b'))),
      jsonResponse(webPayload(fakeResults(10, 'c')))
    ]);
    const { results } = await provider.search('test', { count: 25 });

    assert.equal(fetchImpl.calls.length, 3);
    assert.deepEqual(
      fetchImpl.calls.map(c => new URL(c.url).searchParams.get('offset')),
      ['0', '10', '20']
    );
    assert.equal(results.length, 25);
  });

  it('stops paging at the largest offset the API serves', async () => {
    const { provider, fetchImpl } = makeProvider([
      jsonResponse(webPayload(fakeResults(10, 'a'))),
      jsonResponse(webPayload(fakeResults(10, 'b'))),
      jsonResponse(webPayload(fakeResults(10, 'c'))),
      jsonResponse(webPayload(fakeResults(10, 'd')))
    ]);
    const { results } = await provider.search('test', { count: 999 });

    assert.equal(fetchImpl.calls.length, 4);
    assert.equal(results.length, STAAN_MAX_WEB_RESULTS);
    assert.equal(
      new URL(fetchImpl.calls.at(-1).url).searchParams.get('offset'),
      String(STAAN_MAX_OFFSET)
    );
  });

  it('stops early on a short page instead of spending a request on an empty one', async () => {
    const { provider, fetchImpl } = makeProvider([
      jsonResponse(webPayload(fakeResults(4, 'a'))),
      jsonResponse(webPayload(fakeResults(10, 'b')))
    ]);
    const { results } = await provider.search('test', { count: 30 });

    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(results.length, 4);
  });

  it('de-duplicates results repeated across pages', async () => {
    const { provider } = makeProvider([
      jsonResponse(webPayload(fakeResults(10, 'a'))),
      jsonResponse(webPayload(fakeResults(10, 'a')))
    ]);
    const { results } = await provider.search('test', { count: 20 });
    assert.equal(results.length, 10);
  });

  it('keeps the results already collected when a later page fails', async () => {
    // A paging failure should shorten the answer, not destroy it.
    const { provider } = makeProvider([
      jsonResponse(webPayload(fakeResults(10, 'a'))),
      jsonResponse({ message: 'boom', statusCode: 500 }, { status: 500 })
    ]);
    const { results } = await provider.search('test', { count: 20 });
    assert.equal(results.length, 10);
  });

  it('fails the search when the first page fails', async () => {
    const { provider } = makeProvider(
      jsonResponse({ code: 'INVALID_CREDENTIALS', message: 'Unknown API key' }, { status: 401 })
    );
    await assert.rejects(provider.search('test'), error => {
      assert.equal(error.code, 'STAAN_UNAUTHORIZED');
      assert.equal(error.status, 401);
      return true;
    });
  });

  it('does not retry a rejected key', async () => {
    const { provider, fetchImpl } = makeProvider(
      jsonResponse({ code: 'INVALID_CREDENTIALS', message: 'nope' }, { status: 401 })
    );
    await assert.rejects(provider.search('test'));
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('retries a rate-limited request and succeeds on a later attempt', async () => {
    const { provider, fetchImpl } = makeProvider([
      jsonResponse({ message: 'Too Many Requests', statusCode: 429 }, { status: 429 }),
      jsonResponse(webPayload(fakeResults(2)))
    ]);
    const { results } = await provider.search('test');
    assert.equal(fetchImpl.calls.length, 2);
    assert.equal(results.length, 2);
  });

  it('gives up after the retry budget and reports the rate limit', async () => {
    const { provider, fetchImpl } = makeProvider(
      jsonResponse({ message: 'Too Many Requests', statusCode: 429 }, { status: 429 })
    );
    await assert.rejects(provider.search('test'), error => {
      assert.equal(error.code, 'STAAN_RATE_LIMITED');
      return true;
    });
    assert.equal(fetchImpl.calls.length, 3); // initial + 2 retries
  });

  it('reports a non-JSON body as an invalid response rather than throwing a SyntaxError', async () => {
    const { provider } = makeProvider(htmlResponse(502));
    await assert.rejects(provider.search('test'), error => {
      assert.equal(error.code, 'STAAN_INVALID_RESPONSE');
      return true;
    });
  });

  it('wraps a transport failure with its code and cause intact', async () => {
    const networkError = new Error('fetch failed');
    networkError.code = 'ECONNREFUSED';
    const { provider } = makeProvider(networkError);

    await assert.rejects(provider.search('test'), error => {
      assert.equal(error.code, 'ECONNREFUSED');
      assert.match(error.message, /Staan search request failed/);
      assert.equal(error.cause, networkError);
      return true;
    });
  });

  it('serves a repeat query from the cache without a second request', async () => {
    const { provider, fetchImpl } = makeProvider(jsonResponse(webPayload(fakeResults(2))));
    await provider.search('test');
    await provider.search('test');
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('does not let a different market, count or filter hit the same cache entry', async () => {
    const { provider, fetchImpl } = makeProvider(jsonResponse(webPayload(fakeResults(2))));
    await provider.search('test');
    await provider.search('test', { language: 'de' });
    await provider.search('test', { count: 5 });
    await provider.search('test', { includeDomains: ['a.com'] });
    assert.equal(fetchImpl.calls.length, 4);
  });

  it('bypasses the cache when the admin connectivity test asks it to', async () => {
    // A cached hit would report "reachable" for a key that has since been revoked.
    const { provider, fetchImpl } = makeProvider(jsonResponse(webPayload(fakeResults(2))));
    await provider.search('test');
    await provider.search('test', { skipCache: true });
    assert.equal(fetchImpl.calls.length, 2);
  });

  it('POSTs a JSON body when the search is scoped to domains', async () => {
    const { provider, fetchImpl } = makeProvider(jsonResponse(webPayload(fakeResults(2))));
    await provider.search('enterprise search', { includeDomains: ['intrafind.com'] });

    const { url, options } = fetchImpl.calls[0];
    assert.equal(url, STAAN_API_URL);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body).include_domains, ['intrafind.com']);
  });
});
