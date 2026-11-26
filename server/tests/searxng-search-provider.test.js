#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * SearXNG search provider specs.
 *
 * Request building and response parsing are pure exported functions, and the
 * class takes an injectable `fetchImpl` and `settingsResolver`, so the search
 * path (cache, retries, error mapping, credentials) runs against canned
 * responses. The last suite makes a real TLS handshake with the provider's
 * default transport to pin the SSL whitelist rule (CLAUDE.md, "Outbound
 * Connections and the SSL Whitelist"): a self-hosted instance with a private
 * CA answers only when its host is whitelisted.
 *
 * Run: node --test server/tests/searxng-search-provider.test.js
 */
import { describe, it, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';

import {
  SearxngSearchProvider,
  buildSearxngSearchUrl,
  parseSearxngError,
  parseSearxngResults,
  resolveSearxngLanguage,
  searxngTimeRange,
  unresponsiveEngines,
  SEARXNG_MAX_WEB_RESULTS
} from '../services/search/searxngProvider.js';
import {
  normalizeSearxngBaseUrl,
  searxngAuthorizationHeader,
  isWebSearchEngineConfigured
} from '../services/search/websearchConfig.js';
import { diagnoseSearchError } from '../services/search/searchDiagnostics.js';
import { _clearSearchCache } from '../services/searchCache.js';
import configCache from '../configCache.js';
import { createSelfSignedCertificate, opensslAvailable } from './helpers/selfSignedCertificate.js';

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => lower[String(name).toLowerCase()] ?? null },
    json: async () => body
  };
}

function htmlResponse(status) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => {
      throw new SyntaxError('Unexpected token <');
    }
  };
}

const hit = (n, extra = {}) => ({
  url: `https://example.org/${n}`,
  title: `Title ${n}`,
  content: `Snippet ${n}`,
  engine: 'duckduckgo',
  ...extra
});

const BASE = 'http://searxng.internal:8080';

function provider({ responses, settings = { baseUrl: BASE }, ...deps } = {}) {
  const calls = [];
  const queue = [...responses];
  const instance = new SearxngSearchProvider({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return typeof next === 'function' ? next() : next;
    },
    settingsResolver: () => settings,
    languageResolver: language => language || 'en',
    retryBackoffMs: 1,
    ...deps
  });
  return { instance, calls };
}

beforeEach(() => _clearSearchCache());

describe('the instance URL', () => {
  it('reduces what an admin typed to the base URL', () => {
    assert.equal(normalizeSearxngBaseUrl('http://localhost:8080/search'), 'http://localhost:8080');
    assert.equal(normalizeSearxngBaseUrl(' https://s.example.org/ '), 'https://s.example.org');
    assert.equal(
      normalizeSearxngBaseUrl('https://x.example/searx/search/'),
      'https://x.example/searx'
    );
    assert.equal(normalizeSearxngBaseUrl('http://h:80/a?b=1#c'), 'http://h/a');
  });

  it('rejects what is no http(s) URL or carries credentials', () => {
    for (const bad of [
      undefined,
      '',
      'localhost:8080',
      'ftp://h',
      'http://u:p@h',
      'javascript:1'
    ]) {
      assert.equal(normalizeSearxngBaseUrl(bad), null, String(bad));
    }
  });

  it('is what makes the engine configured', () => {
    const engine = values => ({
      id: 'searxng',
      definition: 'com.intrafind/searxng-search',
      values
    });
    assert.equal(isWebSearchEngineConfigured(engine({ instanceUrl: BASE })), true);
    assert.equal(isWebSearchEngineConfigured(engine({})), false);
  });
});

describe('the Authorization header', () => {
  it('wraps a plain secret as a bearer token and keeps a complete scheme', () => {
    assert.equal(searxngAuthorizationHeader('abc'), 'Bearer abc');
    assert.equal(searxngAuthorizationHeader(' abc \n'), 'Bearer abc');
    assert.equal(searxngAuthorizationHeader('Basic dTpw'), 'Basic dTpw');
    assert.equal(searxngAuthorizationHeader('bearer xyz'), 'bearer xyz');
    assert.equal(searxngAuthorizationHeader('Basic'), 'Bearer Basic');
  });
});

describe('request building', () => {
  it('asks for JSON, the general category and the page', () => {
    const url = new URL(buildSearxngSearchUrl({ baseUrl: BASE, query: 'open source & more' }));
    assert.equal(url.origin + url.pathname, `${BASE}/search`);
    assert.equal(url.searchParams.get('q'), 'open source & more');
    assert.equal(url.searchParams.get('format'), 'json');
    assert.equal(url.searchParams.get('categories'), 'general');
    assert.equal(url.searchParams.get('pageno'), '1');
    assert.equal(url.searchParams.get('safesearch'), '1');
    assert.equal(url.searchParams.has('language'), false);
    assert.equal(url.searchParams.has('time_range'), false);
  });

  it('keeps the path an instance runs under', () => {
    assert.ok(
      buildSearxngSearchUrl({ baseUrl: 'https://h.example/searx', query: 'a' }).startsWith(
        'https://h.example/searx/search?'
      )
    );
  });

  it('maps freshness onto the three ranges SearXNG has (it has no week)', () => {
    assert.equal(searxngTimeRange('day'), 'day');
    assert.equal(searxngTimeRange('week'), 'month');
    assert.equal(searxngTimeRange('Month'), 'month');
    assert.equal(searxngTimeRange('year'), 'year');
    assert.equal(searxngTimeRange('decade'), null);
    assert.equal(searxngTimeRange(undefined), null);
  });

  it('passes a language tag through and drops what is none', () => {
    assert.equal(resolveSearxngLanguage('de'), 'de');
    assert.equal(resolveSearxngLanguage('de_CH'), 'de-CH');
    assert.equal(resolveSearxngLanguage('en-GB'), 'en-GB');
    assert.equal(resolveSearxngLanguage('not a language'), undefined);
    assert.equal(resolveSearxngLanguage(null), undefined);
  });
});

describe('response parsing', () => {
  it('maps content to description, strips markup and reads the date', () => {
    const results = parseSearxngResults({
      results: [
        hit(1, {
          title: '<b>Bold</b> &amp; plain',
          content: 'a  <em>b</em>\n c',
          publishedDate: '2026-05-01T10:00:00'
        }),
        hit(2, { publishedDate: null })
      ]
    });
    assert.equal(results[0].title, 'Bold & plain');
    assert.equal(results[0].description, 'a b c');
    assert.equal(results[0].publishedDate, '2026-05-01T10:00:00.000Z');
    assert.equal(results[1].publishedDate, undefined);
    assert.deepEqual(Object.keys(results[1]).sort(), ['description', 'title', 'url']);
  });

  it('drops results without an http(s) URL and duplicates', () => {
    const results = parseSearxngResults({
      results: [
        hit(1),
        hit(1),
        { title: 'x' },
        { url: 'javascript:alert(1)' },
        { url: 'magnet:?x' }
      ]
    });
    assert.deepEqual(
      results.map(r => r.url),
      ['https://example.org/1']
    );
  });

  it('lists the engines that did not answer', () => {
    assert.deepEqual(
      unresponsiveEngines({ unresponsive_engines: [['google', 'CAPTCHA'], ['bing'], 'junk'] }),
      ['google: CAPTCHA', 'bing']
    );
    assert.deepEqual(unresponsiveEngines(null), []);
  });
});

describe('error classification', () => {
  const code = (payload, status) => parseSearxngError(payload, status)?.code;

  it('names the usual causes by status', () => {
    assert.equal(code(null, 401), 'SEARXNG_UNAUTHORIZED');
    assert.equal(code(null, 403), 'SEARXNG_FORBIDDEN');
    assert.equal(code(null, 404), 'SEARXNG_NOT_FOUND');
    assert.equal(code(null, 429), 'SEARXNG_RATE_LIMITED');
    assert.equal(code(null, 200), 'SEARXNG_INVALID_RESPONSE');
    assert.equal(code({ other: 1 }, 200), 'SEARXNG_INVALID_RESPONSE');
    assert.equal(code({ results: [] }, 500), 'SEARXNG_API_ERROR');
  });

  it('says what to enable on a 403', () => {
    assert.match(parseSearxngError(null, 403).message, /search\.formats/);
  });

  it('reports no results with unresponsive engines as an error, and plain no results as none', () => {
    assert.equal(
      code({ results: [], unresponsive_engines: [['google', 'CAPTCHA']] }, 200),
      'SEARXNG_ENGINES_UNAVAILABLE'
    );
    assert.equal(code({ results: [], unresponsive_engines: [] }, 200), undefined);
    assert.equal(
      code({ results: [hit(1)], unresponsive_engines: [['google', 'CAPTCHA']] }, 200),
      undefined
    );
  });

  it('has a diagnosis for every code', () => {
    for (const c of [
      'SEARXNG_NOT_CONFIGURED',
      'SEARXNG_UNAUTHORIZED',
      'SEARXNG_FORBIDDEN',
      'SEARXNG_NOT_FOUND',
      'SEARXNG_RATE_LIMITED',
      'SEARXNG_INVALID_RESPONSE',
      'SEARXNG_ENGINES_UNAVAILABLE'
    ]) {
      const diagnosis = diagnoseSearchError(Object.assign(new Error('m'), { code: c }), 'searxng');
      assert.equal(diagnosis.code, c);
      assert.match(diagnosis.title, /SearXNG/);
      assert.ok(diagnosis.remediation.length > 0, c);
    }
    assert.match(
      diagnoseSearchError(Object.assign(new Error('m'), { code: 'SEARXNG_FORBIDDEN' }), 'searxng')
        .remediation[0],
      /formats/
    );
  });
});

describe('SearxngSearchProvider', () => {
  it('searches the instance, with the language, and keeps the first count results', async () => {
    const { instance, calls } = provider({
      responses: [jsonResponse({ results: [1, 2, 3, 4].map(n => hit(n)) })]
    });
    const out = await instance.search('iHub', { language: 'de', count: 2, timeRange: 'week' });
    assert.deepEqual(
      out.results.map(r => r.title),
      ['Title 1', 'Title 2']
    );
    const url = new URL(calls[0].url);
    assert.equal(url.searchParams.get('language'), 'de');
    assert.equal(url.searchParams.get('time_range'), 'month');
    assert.equal(calls[0].options.headers.Accept, 'application/json');
    assert.equal(calls[0].options.headers.Authorization, undefined);
  });

  it('caps the count', async () => {
    const results = Array.from({ length: 40 }, (_, n) => hit(n));
    const { instance } = provider({ responses: [jsonResponse({ results })] });
    assert.equal(
      (await instance.search('q', { count: 99 })).results.length,
      SEARXNG_MAX_WEB_RESULTS
    );
  });

  it('sends the authorization of the installation', async () => {
    const { instance, calls } = provider({
      responses: [jsonResponse({ results: [hit(1)] })],
      settings: { baseUrl: BASE, authorization: 'Basic dTpw' }
    });
    await instance.search('q');
    assert.equal(calls[0].options.headers.Authorization, 'Basic dTpw');
  });

  it('uses the settings under test instead of the installation’s', async () => {
    const { instance, calls } = provider({ responses: [jsonResponse({ results: [hit(1)] })] });
    await instance.search('q', { settings: { baseUrl: 'http://other:1' }, skipCache: true });
    assert.ok(calls[0].url.startsWith('http://other:1/search?'));
  });

  it('is configured exactly when the installation has a URL, and refuses to search without', async () => {
    const { instance } = provider({
      responses: [jsonResponse({ results: [] })],
      settings: { baseUrl: null }
    });
    assert.equal(instance.isConfigured(), false);
    await assert.rejects(instance.search('q'), { code: 'SEARXNG_NOT_CONFIGURED' });
  });

  it('caches per instance and query, and skips the cache when asked', async () => {
    const { instance, calls } = provider({ responses: [jsonResponse({ results: [hit(1)] })] });
    await instance.search('q');
    await instance.search('q');
    assert.equal(calls.length, 1);
    await instance.search('q', { skipCache: true });
    assert.equal(calls.length, 2);
    await instance.search('q', { settings: { baseUrl: 'http://other:1' } });
    assert.equal(calls.length, 3);
  });

  it('does not serve a stricter safesearch from a looser one’s cache entry', async () => {
    const { instance, calls } = provider({ responses: [jsonResponse({ results: [hit(1)] })] });
    await instance.search('q', { safesearch: 0 });
    await instance.search('q', { safesearch: 2 });
    await instance.search('q', { safesearch: 2 });
    assert.equal(calls.length, 2);
    assert.equal(new URL(calls[0].url).searchParams.get('safesearch'), '0');
    assert.equal(new URL(calls[1].url).searchParams.get('safesearch'), '2');
  });

  it('retries throttling, then succeeds', async () => {
    const { instance, calls } = provider({
      responses: [jsonResponse(null, { status: 429 }), jsonResponse({ results: [hit(1)] })]
    });
    assert.equal((await instance.search('q')).results.length, 1);
    assert.equal(calls.length, 2);
  });

  it('does not retry a 403 and reports the JSON setting', async () => {
    const { instance, calls } = provider({ responses: [htmlResponse(403)] });
    await assert.rejects(instance.search('q'), err => {
      assert.equal(err.code, 'SEARXNG_FORBIDDEN');
      assert.equal(err.status, 403);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  it('does not cache a failure', async () => {
    const { instance, calls } = provider({
      responses: [htmlResponse(403), jsonResponse({ results: [hit(1)] })]
    });
    await assert.rejects(instance.search('q'));
    assert.equal((await instance.search('q')).results.length, 1);
    assert.equal(calls.length, 2);
  });

  it('wraps a network failure with its code', async () => {
    const { instance } = provider({
      responses: [
        () => {
          throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        }
      ]
    });
    await assert.rejects(instance.search('q'), { code: 'ECONNREFUSED' });
  });
});

describe('the default transport honours the SSL whitelist', () => {
  let certificate;
  let server;
  let port;
  let plain;
  let plainPort;
  const requests = [];

  const serve = (req, res) => {
    requests.push(req.headers);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ results: [hit(1)] }));
  };

  before(async () => {
    plain = http.createServer(serve);
    await new Promise(resolve => plain.listen(0, '127.0.0.1', resolve));
    plainPort = plain.address().port;
    if (!opensslAvailable) return;
    certificate = createSelfSignedCertificate();
    server = https.createServer({ key: certificate.key, cert: certificate.cert }, serve);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    configCache.setCacheEntry('config/platform.json', {});
    await new Promise(resolve => plain.close(resolve));
    if (server) await new Promise(resolve => server.close(resolve));
    certificate?.remove();
  });

  const setSsl = ssl => configCache.setCacheEntry('config/platform.json', { ssl });
  const live = baseUrl =>
    new SearxngSearchProvider({
      settingsResolver: () => ({ baseUrl, authorization: 'Bearer t0k3n' }),
      languageResolver: () => 'en'
    });

  it('talks plain http to an internal instance and sends the credential', async () => {
    setSsl({ ignoreInvalidCertificates: false, domainWhitelist: [] });
    const out = await live(`http://127.0.0.1:${plainPort}`).search('q', { skipCache: true });
    assert.equal(out.results.length, 1);
    assert.equal(requests.at(-1).authorization, 'Bearer t0k3n');
  });

  it(
    'answers from a self-signed instance only when its host is whitelisted',
    { skip: !opensslAvailable },
    async () => {
      const baseUrl = `https://127.0.0.1:${port}`;

      setSsl({ ignoreInvalidCertificates: true, domainWhitelist: ['127.0.0.1'] });
      assert.equal((await live(baseUrl).search('q', { skipCache: true })).results.length, 1);

      setSsl({ ignoreInvalidCertificates: true, domainWhitelist: ['other.example'] });
      await assert.rejects(
        live(baseUrl).search('q', { skipCache: true }),
        /SearXNG search request failed/
      );

      setSsl({ ignoreInvalidCertificates: false, domainWhitelist: ['127.0.0.1'] });
      await assert.rejects(
        live(baseUrl).search('q', { skipCache: true }),
        /SearXNG search request failed/
      );
    }
  );
});
