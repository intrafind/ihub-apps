#!/usr/bin/env node

/**
 * Qwant search provider specs.
 *
 * The provider is built so this suite needs no network, no mock framework and
 * no module interception: request building and response parsing are pure
 * exported functions, and the class takes an injectable `fetchImpl`, so the
 * whole search path — cache, retries, DataDome cookie round-trip, error
 * mapping — runs against canned responses.
 *
 * Run: node --test server/tests/qwant-search-provider.test.js
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  QwantSearchProvider,
  buildQwantSearchUrl,
  extractDatadomeCookie,
  parseQwantError,
  parseQwantWebResults,
  resolveQwantLocale,
  QWANT_API_URL,
  QWANT_DEFAULT_LOCALE,
  QWANT_MAX_WEB_RESULTS
} from '../services/search/qwantProvider.js';
import { _clearSearchCache } from '../services/searchCache.js';

/** A fetch-style Response over a canned JSON body. */
function jsonResponse(body, { status = 200, headers = {}, setCookie = [] } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: {
      get: name => lower[String(name).toLowerCase()] ?? null,
      getSetCookie: () => setCookie
    },
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

/** A response whose body is not JSON at all (an HTML challenge page). */
function htmlResponse(status = 403) {
  return {
    ok: false,
    status,
    statusText: 'Forbidden',
    headers: { get: () => null, getSetCookie: () => [] },
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
    text: async () => '<html>blocked</html>'
  };
}

/** A successful Qwant web payload wrapping `items`. */
function webPayload(items, extraBlocks = []) {
  return {
    status: 'success',
    data: {
      result: {
        items: {
          mainline: [{ type: 'web', items }, ...extraBlocks]
        }
      }
    }
  };
}

/** Records every call so assertions can look at the URL and headers sent. */
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

describe('resolveQwantLocale', () => {
  it('expands a bare language tag to a supported locale', () => {
    assert.equal(resolveQwantLocale('de'), 'de_DE');
    assert.equal(resolveQwantLocale('fr'), 'fr_FR');
    assert.equal(resolveQwantLocale('en'), 'en_US');
  });

  it('accepts hyphen, underscore and mixed case forms of the same locale', () => {
    assert.equal(resolveQwantLocale('de-CH'), 'de_CH');
    assert.equal(resolveQwantLocale('de_ch'), 'de_CH');
    assert.equal(resolveQwantLocale('DE_CH'), 'de_CH');
  });

  it('falls back to the language default when the region is unsupported', () => {
    // Qwant has de_DE/de_AT/de_CH but no de_LI.
    assert.equal(resolveQwantLocale('de-LI'), 'de_DE');
  });

  it('falls back to en_US for unknown, empty and non-string input', () => {
    assert.equal(resolveQwantLocale('xx'), QWANT_DEFAULT_LOCALE);
    assert.equal(resolveQwantLocale(''), QWANT_DEFAULT_LOCALE);
    assert.equal(resolveQwantLocale(undefined), QWANT_DEFAULT_LOCALE);
    assert.equal(resolveQwantLocale(42), QWANT_DEFAULT_LOCALE);
  });
});

describe('buildQwantSearchUrl', () => {
  const params = url => new URL(url).searchParams;

  it('targets the web category on the documented API base', () => {
    const url = buildQwantSearchUrl({ query: 'test' });
    assert.ok(url.startsWith(`${QWANT_API_URL}web?`), url);
  });

  it('encodes the query and sends the parameters the web front-end sends', () => {
    const p = params(buildQwantSearchUrl({ query: 'foo & bar', locale: 'de_DE' }));
    assert.equal(p.get('q'), 'foo & bar');
    assert.equal(p.get('locale'), 'de_DE');
    assert.equal(p.get('device'), 'desktop');
    // Literal strings, not booleans: "True" would fingerprint the caller.
    assert.equal(p.get('displayed'), 'true');
    assert.equal(p.get('llm'), 'true');
    assert.ok(p.get('tgp'));
  });

  it('clamps count to what one web request can return', () => {
    assert.equal(params(buildQwantSearchUrl({ query: 'x', count: 50 })).get('count'), '10');
    assert.equal(params(buildQwantSearchUrl({ query: 'x', count: 0 })).get('count'), '1');
    assert.equal(params(buildQwantSearchUrl({ query: 'x', count: 5 })).get('count'), '5');
    assert.equal(
      params(buildQwantSearchUrl({ query: 'x', count: 'nonsense' })).get('count'),
      String(QWANT_MAX_WEB_RESULTS)
    );
  });

  it('clamps safesearch into 0…2 and defaults to moderate', () => {
    assert.equal(params(buildQwantSearchUrl({ query: 'x' })).get('safesearch'), '1');
    assert.equal(params(buildQwantSearchUrl({ query: 'x', safesearch: 9 })).get('safesearch'), '2');
    assert.equal(
      params(buildQwantSearchUrl({ query: 'x', safesearch: -1 })).get('safesearch'),
      '0'
    );
  });

  it('rejects a negative offset and honours a positive one', () => {
    assert.equal(params(buildQwantSearchUrl({ query: 'x', offset: -5 })).get('offset'), '0');
    assert.equal(params(buildQwantSearchUrl({ query: 'x', offset: 20 })).get('offset'), '20');
  });

  it('accepts an endpoint override with or without a trailing slash', () => {
    assert.ok(
      buildQwantSearchUrl({ query: 'x', endpoint: 'https://example.test/v3/search' }).startsWith(
        'https://example.test/v3/search/web?'
      )
    );
    assert.ok(
      buildQwantSearchUrl({ query: 'x', endpoint: 'https://example.test/v3/search/' }).startsWith(
        'https://example.test/v3/search/web?'
      )
    );
  });
});

describe('parseQwantError', () => {
  it('returns null for a successful payload', () => {
    assert.equal(parseQwantError({ status: 'success', data: {} }, 200), null);
  });

  it('reports a DataDome challenge as a captcha, not as a bare HTTP 403', () => {
    // The body this suite's fixture mirrors is what api.qwant.com actually
    // returns to a data-centre IP: a 403 whose payload is a captcha URL.
    const error = parseQwantError({ url: 'https://geo.captcha-delivery.com/captcha/?cid=x' }, 403);
    assert.equal(error.code, 'QWANT_CAPTCHA');
    assert.match(error.message, /captcha/i);
    // The message has to say what to do about it — the cause is the egress IP,
    // not the query, so a retry will not help.
    assert.match(error.message, /data-centre IP|Brave/);
  });

  it('maps Qwant error code 24 to a rate limit', () => {
    const error = parseQwantError({ status: 'error', data: { error_code: 24 } }, 200);
    assert.equal(error.code, 'QWANT_RATE_LIMITED');
  });

  it('reports a plain 403 without a captcha body as access denied', () => {
    assert.equal(parseQwantError({ status: 'error', data: {} }, 403).code, 'QWANT_ACCESS_DENIED');
  });

  it('reports a non-JSON body rather than throwing', () => {
    const error = parseQwantError(null, 500);
    assert.equal(error.code, 'QWANT_INVALID_RESPONSE');
    assert.match(error.message, /500/);
  });

  it('surfaces the API message and code for any other failure', () => {
    const error = parseQwantError(
      { status: 'error', data: { error_code: 8, message: ['Unknown Category'] } },
      200
    );
    assert.equal(error.code, 'QWANT_API_ERROR');
    assert.match(error.message, /Unknown Category/);
    assert.match(error.message, /\(8\)/);
  });
});

describe('parseQwantWebResults', () => {
  it('maps items onto the shape every search provider returns', () => {
    const results = parseQwantWebResults(
      webPayload([{ title: 'Example', url: 'https://example.com', desc: 'An example page' }])
    );
    assert.deepEqual(results, [
      { title: 'Example', url: 'https://example.com', description: 'An example page' }
    ]);
  });

  it('drops ads and other non-web blocks from the same mainline list', () => {
    const results = parseQwantWebResults(
      webPayload(
        [{ title: 'Real', url: 'https://real.test', desc: '' }],
        [
          { type: 'ads', items: [{ title: 'Ad', url: 'https://ad.test', desc: '' }] },
          { type: 'related_searches', items: [{ title: 'Related', url: 'https://rel.test' }] }
        ]
      )
    );
    assert.deepEqual(
      results.map(r => r.url),
      ['https://real.test']
    );
  });

  it('skips items with no URL and tolerates missing title/desc', () => {
    const results = parseQwantWebResults(
      webPayload([{ title: 'No URL', desc: 'dropped' }, { url: 'https://bare.test' }])
    );
    assert.deepEqual(results, [{ title: '', url: 'https://bare.test', description: '' }]);
  });

  it('normalises second- and millisecond-precision dates to ISO', () => {
    const seconds = parseQwantWebResults(
      webPayload([{ title: 't', url: 'https://a.test', desc: '', date: 1700000000 }])
    );
    const millis = parseQwantWebResults(
      webPayload([{ title: 't', url: 'https://b.test', desc: '', date: 1700000000000 }])
    );
    assert.equal(seconds[0].publishedDate, millis[0].publishedDate);
    assert.equal(seconds[0].publishedDate, new Date(1700000000000).toISOString());
  });

  it('omits publishedDate when the date is absent or unusable', () => {
    const results = parseQwantWebResults(
      webPayload([{ title: 't', url: 'https://a.test', desc: '', date: 0 }])
    );
    assert.equal('publishedDate' in results[0], false);
  });

  it('returns an empty array for an empty or malformed payload', () => {
    assert.deepEqual(parseQwantWebResults(undefined), []);
    assert.deepEqual(parseQwantWebResults({}), []);
    assert.deepEqual(parseQwantWebResults({ data: { result: { items: {} } } }), []);
  });
});

describe('extractDatadomeCookie', () => {
  it('reads the cookie from a getSetCookie() list', () => {
    const headers = {
      getSetCookie: () => ['other=1; Path=/', 'datadome=ABC123; Max-Age=31536000; Path=/']
    };
    assert.equal(extractDatadomeCookie(headers), 'ABC123');
  });

  it('reads the cookie from a single joined set-cookie header', () => {
    const headers = { get: name => (name === 'set-cookie' ? 'a=1, datadome=XYZ; Path=/' : null) };
    assert.equal(extractDatadomeCookie(headers), 'XYZ');
  });

  it('returns null when no datadome cookie is set', () => {
    assert.equal(extractDatadomeCookie({ getSetCookie: () => ['a=1'] }), null);
    assert.equal(extractDatadomeCookie(null), null);
  });
});

describe('QwantSearchProvider', () => {
  beforeEach(() => _clearSearchCache());

  it('identifies itself and needs no configuration', () => {
    const provider = new QwantSearchProvider({ fetchImpl: async () => jsonResponse({}) });
    assert.equal(provider.getName(), 'qwant');
    // This is the whole point of the provider: usable with no API key at all.
    assert.equal(provider.isConfigured(), true);
  });

  it('returns parsed results for a successful search', async () => {
    const fetchImpl = recordingFetch(
      jsonResponse(
        webPayload([
          { title: 'iHub', url: 'https://ihub.test', desc: 'Docs' },
          { title: 'Other', url: 'https://other.test', desc: 'More' }
        ])
      )
    );
    const provider = new QwantSearchProvider({ fetchImpl });

    const { results } = await provider.search('ihub apps');

    assert.equal(results.length, 2);
    assert.equal(results[0].url, 'https://ihub.test');
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('sends the browser headers the API requires', async () => {
    const fetchImpl = recordingFetch(jsonResponse(webPayload([])));
    await new QwantSearchProvider({ fetchImpl }).search('headers');

    const { headers } = fetchImpl.calls[0].options;
    assert.equal(headers.Accept, 'application/json');
    assert.equal(headers.Origin, 'https://www.qwant.com');
    assert.equal(headers.Referer, 'https://www.qwant.com/');
    // A default Node user agent is answered with a bot challenge.
    assert.match(headers['User-Agent'], /Mozilla/);
  });

  it('passes the requested language through as a Qwant locale', async () => {
    const fetchImpl = recordingFetch(jsonResponse(webPayload([])));
    await new QwantSearchProvider({ fetchImpl }).search('hallo', { language: 'de' });

    assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get('locale'), 'de_DE');
  });

  it('honours the requested result count', async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      title: `r${i}`,
      url: `https://r${i}.test`,
      desc: ''
    }));
    const fetchImpl = recordingFetch(jsonResponse(webPayload(items)));

    const { results } = await new QwantSearchProvider({ fetchImpl }).search('many', { count: 3 });

    assert.equal(results.length, 3);
    assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get('count'), '3');
  });

  it('replays the datadome cookie Qwant sets on the next request', async () => {
    const fetchImpl = recordingFetch([
      jsonResponse(webPayload([]), { setCookie: ['datadome=COOKIE1; Path=/'] }),
      jsonResponse(webPayload([]))
    ]);
    const provider = new QwantSearchProvider({ fetchImpl });

    await provider.search('first');
    await provider.search('second');

    assert.equal(fetchImpl.calls[0].options.headers.Cookie, undefined);
    assert.equal(fetchImpl.calls[1].options.headers.Cookie, 'datadome=COOKIE1');
  });

  it('serves a repeated query from the cache instead of the network', async () => {
    const fetchImpl = recordingFetch(
      jsonResponse(webPayload([{ title: 'a', url: 'https://a.test', desc: '' }]))
    );
    const provider = new QwantSearchProvider({ fetchImpl });

    await provider.search('same query');
    const second = await provider.search('  Same   Query  ');

    assert.equal(fetchImpl.calls.length, 1, 'the repeat query hit the network');
    assert.equal(second.results[0].url, 'https://a.test');
  });

  it('caches per locale, so a German search does not return the English results', async () => {
    const fetchImpl = recordingFetch([
      jsonResponse(webPayload([{ title: 'en', url: 'https://en.test', desc: '' }])),
      jsonResponse(webPayload([{ title: 'de', url: 'https://de.test', desc: '' }]))
    ]);
    const provider = new QwantSearchProvider({ fetchImpl });

    const en = await provider.search('berlin', { language: 'en' });
    const de = await provider.search('berlin', { language: 'de' });

    assert.equal(fetchImpl.calls.length, 2);
    assert.equal(en.results[0].url, 'https://en.test');
    assert.equal(de.results[0].url, 'https://de.test');
  });

  it('fails a captcha immediately instead of retrying — the IP will not change', async () => {
    const fetchImpl = recordingFetch(
      jsonResponse({ url: 'https://geo.captcha-delivery.com/captcha/?cid=x' }, { status: 403 })
    );
    const provider = new QwantSearchProvider({ fetchImpl });

    await assert.rejects(provider.search('blocked'), err => {
      assert.equal(err.code, 'QWANT_CAPTCHA');
      assert.equal(err.status, 403);
      return true;
    });
    assert.equal(fetchImpl.calls.length, 1, 'a captcha must not be retried');
  });

  it('retries a rate limit and succeeds when the next attempt goes through', async () => {
    const fetchImpl = recordingFetch([
      jsonResponse({ status: 'error', data: { error_code: 24 } }),
      jsonResponse(webPayload([{ title: 'ok', url: 'https://ok.test', desc: '' }]))
    ]);
    const provider = new QwantSearchProvider({ fetchImpl, retryBackoffMs: 1 });

    const { results } = await provider.search('busy');

    assert.equal(fetchImpl.calls.length, 2);
    assert.equal(results[0].url, 'https://ok.test');
  });

  it('gives up after the retry budget and reports the rate limit', async () => {
    const fetchImpl = recordingFetch(jsonResponse({ status: 'error', data: { error_code: 24 } }));
    const provider = new QwantSearchProvider({ fetchImpl, retryBackoffMs: 1 });

    await assert.rejects(provider.search('always busy'), err => {
      assert.equal(err.code, 'QWANT_RATE_LIMITED');
      return true;
    });
    assert.equal(fetchImpl.calls.length, 3, 'expected the initial call plus two retries');
  });

  it('classifies a non-JSON challenge page instead of throwing a SyntaxError', async () => {
    const provider = new QwantSearchProvider({ fetchImpl: recordingFetch(htmlResponse(403)) });

    await assert.rejects(provider.search('html'), err => {
      assert.equal(err.code, 'QWANT_ACCESS_DENIED');
      return true;
    });
  });

  it('wraps a transport failure with its code and cause for proxy diagnosis', async () => {
    const networkError = Object.assign(new Error('fetch failed'), {
      code: 'ECONNREFUSED',
      cause: new Error('connect ECONNREFUSED 10.0.0.1:443')
    });
    const provider = new QwantSearchProvider({ fetchImpl: recordingFetch(networkError) });

    await assert.rejects(provider.search('offline'), err => {
      assert.equal(err.code, 'ECONNREFUSED');
      assert.match(err.message, /Qwant search request failed/);
      assert.match(err.message, /ECONNREFUSED 10\.0\.0\.1/);
      return true;
    });
  });

  it('does not cache a failed search', async () => {
    const fetchImpl = recordingFetch([
      jsonResponse({ url: 'https://geo.captcha-delivery.com/x' }, { status: 403 }),
      jsonResponse(webPayload([{ title: 'ok', url: 'https://ok.test', desc: '' }]))
    ]);
    const provider = new QwantSearchProvider({ fetchImpl });

    await assert.rejects(provider.search('retry later'));
    const { results } = await provider.search('retry later');

    assert.equal(results[0].url, 'https://ok.test');
  });
});
