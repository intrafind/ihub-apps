// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * No outbound connection in the tools (`server/tools/`) and the run service
 * (`server/services/run/`) skips the SSL whitelist: a bare `fetch(`, an
 * `http.request(` / `https.request(` / `http.get(` / `https.get(` without an
 * agent of `createAgent()` or the options of `getTlsBypassOptions()`, or a
 * `new WebSocket(` without `getWebSocketTlsOptions(url)` merged into its
 * options fails this guard. Such a call ignores
 * `ssl.ignoreInvalidCertificates` and `ssl.domainWhitelist` (and the proxy
 * configuration), so a self-hosted endpoint with a private CA fails with
 * "unable to verify the first certificate" (CLAUDE.md, "Outbound Connections
 * and the SSL Whitelist").
 *
 * The way to make one: `httpFetch()` / `createAgent()` of
 * `server/utils/httpConfig.js` for HTTP(S), `getWebSocketTlsOptions(url)`
 * merged into the `ws` options for a WebSocket, `getTlsBypassOptions(url)` for
 * anything else. Those helpers are what `httpConfig.fetch-ssl-whitelist.test.js`
 * and `httpConfig.websocket-tls.test.js` test with a whitelisted and a
 * non-whitelisted host; this guard keeps the tools and the run service on them.
 * There is no allow-list.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SERVER_ROOT, codeOf, compareWithAllowList, scan } from './sourceScan.js';

/** The directories this guard scans, relative to the server directory. */
export const GUARDED_DIRS = Object.freeze(['tools', 'services/run']);

/**
 * The text between the parentheses of the call whose `(` is at `open`, or the
 * rest of the code when they do not close.
 *
 * @param {string} code
 * @param {number} open
 * @returns {string}
 */
function argumentsAt(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')' && --depth === 0) return code.slice(open + 1, i);
  }
  return code.slice(open + 1);
}

/**
 * Whether the code makes a call of `pattern` whose arguments do not carry one
 * of the helpers that apply the SSL whitelist.
 *
 * @param {string} code
 * @param {RegExp} pattern - global; matches up to and including the `(`
 * @param {RegExp|null} helpers - what in the arguments makes the call honour the whitelist
 * @returns {boolean}
 */
function bareCall(code, pattern, helpers) {
  for (const match of code.matchAll(pattern)) {
    const args = argumentsAt(code, match.index + match[0].length - 1);
    if (!helpers || !helpers.test(args)) return true;
  }
  return false;
}

/** The rules of this guard. */
export const RULES = Object.freeze({
  // `fetch(` itself, not `httpFetch(`, `safeFetch(` or a method `.fetch(`.
  fetch: code => bareCall(code, /(?<![\w$.])fetch\s*\(/g, null),
  // Allowed with an agent of `createAgent()` or the options of `getTlsBypassOptions()`.
  'http.request': code =>
    bareCall(
      code,
      /(?<![\w$])https?\s*\.\s*(?:request|get)\s*\(/g,
      /\b(?:createAgent|getTlsBypassOptions)\s*\(/
    ),
  // Allowed with `getWebSocketTlsOptions(url)` (or `getTlsBypassOptions`) merged into its options.
  'new WebSocket': code =>
    bareCall(
      code,
      /\bnew\s+WebSocket\s*\(/g,
      /\b(?:getWebSocketTlsOptions|getTlsBypassOptions)\s*\(/
    )
});

test('no bare fetch(, http(s).request(, http(s).get( or new WebSocket( in the tools and the run service', async () => {
  const found = await scan(SERVER_ROOT, RULES, { under: GUARDED_DIRS });
  assert.deepEqual(
    compareWithAllowList(found, []).unlisted,
    [],
    'an outbound connection that skips ssl.domainWhitelist: use httpFetch() / createAgent() (server/utils/httpConfig.js), getWebSocketTlsOptions(url) or getTlsBypassOptions(url)'
  );
});

test('the guard scans files that exist', async () => {
  const { sourceFiles } = await import('./sourceScan.js');
  const files = await sourceFiles(SERVER_ROOT, { under: GUARDED_DIRS });
  assert.ok(
    files.some(rel => rel.startsWith('tools/')),
    'files under tools/'
  );
  assert.ok(files.includes('services/run/RunService.js'), 'files under services/run/');
});

test('the check sees each bare call, and not the helpers, a method or a comment', () => {
  const breaks = (rule, source) => RULES[rule](codeOf(source));
  assert.equal(breaks('fetch', 'const res = await fetch(url);'), true);
  assert.equal(breaks('fetch', 'return fetch(`${base}/x`, { method: "POST" });'), true);
  assert.equal(breaks('fetch', 'const res = await httpFetch(url, options);'), false);
  assert.equal(breaks('fetch', 'const res = await safeFetch(url);'), false);
  assert.equal(breaks('fetch', 'await cache.fetch(key);'), false);
  assert.equal(breaks('fetch', '// fetch(url) skips the whitelist'), false);
  assert.equal(breaks('http.request', 'const req = https.request(options, onResponse);'), true);
  assert.equal(breaks('http.request', 'http.get(url, cb);'), true);
  assert.equal(breaks('http.request', 'const agent = createAgent(url);'), false);
  assert.equal(
    breaks('http.request', 'https.request({ ...options, agent: createAgent(url) }, cb);'),
    false
  );
  assert.equal(breaks('new WebSocket', 'const ws = new WebSocket(url);'), true);
  assert.equal(breaks('new WebSocket', 'new WebSocket(url, { headers: h(x) });'), true);
  assert.equal(
    breaks('new WebSocket', 'const ws = new WebSocket(url, { ...getWebSocketTlsOptions(url) });'),
    false
  );
  assert.equal(breaks('new WebSocket', 'import WebSocket from "ws";'), false);
});

test('a bare call in a scratch file under the guarded directories fails the guard (negative fixture)', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-arch-outbound-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (rel, source) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), source);
  };
  // A whitelisted host and one that is not: neither may be reached past the helpers.
  await write('tools/scratchSearch.js', "await fetch('https://search.example.com/api');\n");
  await write(
    'services/run/scratchProbe.js',
    "https.request({ host: 'untrusted.example.net' });\nnew WebSocket('wss://whitelisted.example.com');\n"
  );
  await write(
    'services/run/scratchSocket.js',
    "new WebSocket('wss://whitelisted.example.com', { ...getWebSocketTlsOptions('wss://whitelisted.example.com') });\n"
  );
  await write('tools/helperOnly.js', "await httpFetch('https://search.example.com/api');\n");
  // Outside the guarded directories the guard does not look.
  await write('services/elsewhere/ok.js', "await fetch('https://example.com');\n");
  const found = await scan(root, RULES, { under: GUARDED_DIRS });
  assert.deepEqual(compareWithAllowList(found, []).unlisted, [
    'services/run/scratchProbe.js: http.request',
    'services/run/scratchProbe.js: new WebSocket',
    'tools/scratchSearch.js: fetch'
  ]);
});
