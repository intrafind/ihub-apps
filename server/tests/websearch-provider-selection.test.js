#!/usr/bin/env node

/**
 * `websearch.provider` → search tool resolution.
 *
 * This is the switch an admin actually turns in Admin → Apps → Web Search, and
 * it decides which script the model ends up calling. The `"auto"` branch is the
 * one worth pinning down: it walks the keyed engines in order — Brave, then
 * Staan — and lands on the keyless Qwant only when neither has a key, because
 * the point of the fallback chain is that an install without a search
 * subscription stops offering the model a tool that fails on every call.
 *
 * Run: node --test server/tests/websearch-provider-selection.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  resolveWebsearchToolId,
  WEBSEARCH_TOOL_IDS,
  NATIVE_WEB_SEARCH_FALLBACK_TOOL_ID
} from '../toolLoader.js';

const withBraveKey = { braveConfigured: () => true, staanConfigured: () => false };
const withoutBraveKey = { braveConfigured: () => false, staanConfigured: () => false };
const withStaanKeyOnly = { braveConfigured: () => false, staanConfigured: () => true };
const withBothKeys = { braveConfigured: () => true, staanConfigured: () => true };

describe('resolveWebsearchToolId', () => {
  it('maps each named provider onto its tool', () => {
    assert.equal(resolveWebsearchToolId('brave', withoutBraveKey), 'braveSearch');
    assert.equal(resolveWebsearchToolId('staan', withoutBraveKey), 'staanSearch');
    assert.equal(resolveWebsearchToolId('qwant', withBraveKey), 'qwantSearch');
  });

  it('honours a named provider even when it is not configured', () => {
    // Deliberate: the call then fails naming the engine the admin chose,
    // instead of quietly answering from a different one.
    assert.equal(resolveWebsearchToolId('brave', withoutBraveKey), 'braveSearch');
  });

  it('auto picks Brave when the install has a Brave API key', () => {
    assert.equal(resolveWebsearchToolId('auto', withBraveKey), 'braveSearch');
  });

  it('auto picks Staan when only Staan has a key', () => {
    assert.equal(resolveWebsearchToolId('auto', withStaanKeyOnly), 'staanSearch');
  });

  it('auto keeps preferring Brave when both keyed engines are configured', () => {
    // An install that already had a Brave key must not change engine on upgrade.
    assert.equal(resolveWebsearchToolId('auto', withBothKeys), 'braveSearch');
  });

  it('auto falls back to the keyless Qwant when neither keyed engine has a key', () => {
    assert.equal(resolveWebsearchToolId('auto', withoutBraveKey), 'qwantSearch');
  });

  it('treats a missing provider value as auto', () => {
    assert.equal(resolveWebsearchToolId(undefined, withBraveKey), 'braveSearch');
    assert.equal(resolveWebsearchToolId(undefined, withoutBraveKey), 'qwantSearch');
  });

  it('falls back to Brave for an unrecognised provider value', () => {
    assert.equal(
      resolveWebsearchToolId('bing', withoutBraveKey),
      NATIVE_WEB_SEARCH_FALLBACK_TOOL_ID
    );
  });

  it('only ever names a tool that exists', () => {
    const known = new Set(Object.values(WEBSEARCH_TOOL_IDS));
    for (const provider of ['auto', 'brave', 'staan', 'qwant', 'nonsense', undefined]) {
      for (const deps of [withBraveKey, withoutBraveKey, withStaanKeyOnly, withBothKeys]) {
        assert.ok(known.has(resolveWebsearchToolId(provider, deps)));
      }
    }
  });

  it('covers every provider the app schema accepts', async () => {
    // Drift guard: a new value added to the schema enum without a matching tool
    // here would silently resolve to Brave, so an app configured for the new
    // engine would answer from the old one with nothing in the logs to say so.
    const source = await readFile(
      new URL('../validators/appConfigSchema.js', import.meta.url),
      'utf8'
    );
    const match = /provider:\s*z\s*\n?\s*\.enum\(\[([^\]]+)\]\)/.exec(source);
    assert.ok(match, 'could not read the websearch provider enum from appConfigSchema.js');

    const enumValues = match[1]
      .split(',')
      .map(v => v.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);

    assert.ok(enumValues.includes('auto'), 'expected "auto" in the schema enum');
    for (const provider of enumValues.filter(v => v !== 'auto')) {
      assert.ok(WEBSEARCH_TOOL_IDS[provider], `no tool mapped for schema provider "${provider}"`);
    }
    // And the reverse: every tool in the map is selectable from the schema.
    for (const provider of Object.keys(WEBSEARCH_TOOL_IDS)) {
      assert.ok(enumValues.includes(provider), `provider "${provider}" is not in the schema enum`);
    }
  });
});
