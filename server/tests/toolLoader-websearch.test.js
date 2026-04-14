/**
 * Unit tests for resolveWebsearchTool() in toolLoader
 * Covers: provider selection matrix, websearchEnabled toggle, parameter override behavior
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _resolveWebsearchTool } from '../toolLoader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp(overrides = {}) {
  return {
    websearch: {
      enabled: true,
      provider: 'auto',
      useNativeSearch: true,
      maxResults: 5,
      extractContent: true,
      contentMaxLength: 3000,
      enabledByDefault: false,
      ...overrides
    }
  };
}

function makeTool(id, extraProps = {}) {
  return {
    id,
    parameters: {
      properties: {
        query: { type: 'string' },
        maxResults: { type: 'number', default: 10 },
        extractContent: { type: 'boolean', default: false },
        contentMaxLength: { type: 'number', default: 5000 },
        ...extraProps
      }
    }
  };
}

const STUB_TOOLS = [
  makeTool('googleSearch'),
  makeTool('webSearch'),
  makeTool('braveSearch'),
  {
    id: 'tavilySearch',
    parameters: {
      properties: {
        query: { type: 'string' },
        max_results: { type: 'number', default: 10 }, // tavily uses snake_case
        extractContent: { type: 'boolean', default: false },
        contentMaxLength: { type: 'number', default: 5000 }
      }
    }
  }
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveWebsearchTool()', () => {
  // ── Guard conditions ──────────────────────────────────────────────────────

  it('returns [] when app has no websearch config', () => {
    const result = _resolveWebsearchTool({}, 'google', STUB_TOOLS, true);
    assert.deepEqual(result, []);
  });

  it('returns [] when websearch.enabled is false', () => {
    const app = makeApp({ enabled: false });
    const result = _resolveWebsearchTool(app, 'google', STUB_TOOLS, true);
    assert.deepEqual(result, []);
  });

  // ── websearchEnabled toggle ───────────────────────────────────────────────

  it('returns [] when websearchEnabled is false (user disabled)', () => {
    const app = makeApp({ enabledByDefault: true });
    const result = _resolveWebsearchTool(app, 'google', STUB_TOOLS, false);
    assert.deepEqual(result, []);
  });

  it('returns tool when websearchEnabled is true', () => {
    const app = makeApp();
    const result = _resolveWebsearchTool(app, 'google', STUB_TOOLS, true);
    assert.equal(result.length, 1);
  });

  it('uses enabledByDefault when websearchEnabled is undefined and enabledByDefault is true', () => {
    const app = makeApp({ enabledByDefault: true });
    const result = _resolveWebsearchTool(app, 'google', STUB_TOOLS, undefined);
    assert.equal(result.length, 1);
  });

  it('returns [] when websearchEnabled is undefined and enabledByDefault is false', () => {
    const app = makeApp({ enabledByDefault: false });
    const result = _resolveWebsearchTool(app, 'google', STUB_TOOLS, undefined);
    assert.deepEqual(result, []);
  });

  // ── Provider selection matrix ─────────────────────────────────────────────

  it('selects googleSearch for google provider when useNativeSearch is true', () => {
    const app = makeApp({ useNativeSearch: true });
    const [tool] = _resolveWebsearchTool(app, 'google', STUB_TOOLS, true);
    assert.equal(tool.id, 'googleSearch');
  });

  it('selects webSearch for openai-responses provider when useNativeSearch is true', () => {
    const app = makeApp({ useNativeSearch: true });
    const [tool] = _resolveWebsearchTool(app, 'openai-responses', STUB_TOOLS, true);
    assert.equal(tool.id, 'webSearch');
  });

  it('selects braveSearch for unknown provider when useNativeSearch is true and provider is auto', () => {
    const app = makeApp({ useNativeSearch: true, provider: 'auto' });
    const [tool] = _resolveWebsearchTool(app, 'openai', STUB_TOOLS, true);
    assert.equal(tool.id, 'braveSearch');
  });

  it('selects tavilySearch when provider is tavily', () => {
    const app = makeApp({ provider: 'tavily' });
    const [tool] = _resolveWebsearchTool(app, 'openai', STUB_TOOLS, true);
    assert.equal(tool.id, 'tavilySearch');
  });

  it('forces braveSearch for google when useNativeSearch is false', () => {
    const app = makeApp({ useNativeSearch: false, provider: 'brave' });
    const [tool] = _resolveWebsearchTool(app, 'google', STUB_TOOLS, true);
    assert.equal(tool.id, 'braveSearch');
  });

  it('forces tavilySearch for openai-responses when useNativeSearch is false and provider is tavily', () => {
    const app = makeApp({ useNativeSearch: false, provider: 'tavily' });
    const [tool] = _resolveWebsearchTool(app, 'openai-responses', STUB_TOOLS, true);
    assert.equal(tool.id, 'tavilySearch');
  });

  it('returns [] when resolved tool id is not in allTools', () => {
    const app = makeApp({ useNativeSearch: true });
    const result = _resolveWebsearchTool(app, 'google', [], true);
    assert.deepEqual(result, []);
  });

  // ── Parameter override behavior ───────────────────────────────────────────

  it('overrides maxResults default from websearch config', () => {
    const app = makeApp({ maxResults: 3 });
    const [tool] = _resolveWebsearchTool(app, 'openai', STUB_TOOLS, true);
    assert.equal(tool.parameters.properties.maxResults.default, 3);
  });

  it('overrides max_results (snake_case) for tavilySearch', () => {
    const app = makeApp({ provider: 'tavily', maxResults: 7 });
    const [tool] = _resolveWebsearchTool(app, 'openai', STUB_TOOLS, true);
    assert.equal(tool.id, 'tavilySearch');
    assert.equal(tool.parameters.properties.max_results.default, 7);
  });

  it('overrides extractContent default from websearch config', () => {
    const app = makeApp({ extractContent: false });
    const [tool] = _resolveWebsearchTool(app, 'openai', STUB_TOOLS, true);
    assert.equal(tool.parameters.properties.extractContent.default, false);
  });

  it('overrides contentMaxLength default from websearch config', () => {
    const app = makeApp({ contentMaxLength: 1500 });
    const [tool] = _resolveWebsearchTool(app, 'openai', STUB_TOOLS, true);
    assert.equal(tool.parameters.properties.contentMaxLength.default, 1500);
  });

  it('does not mutate the original tool definition in allTools', () => {
    const app = makeApp({ maxResults: 2 });
    _resolveWebsearchTool(app, 'openai', STUB_TOOLS, true);
    const original = STUB_TOOLS.find(t => t.id === 'braveSearch');
    assert.equal(original.parameters.properties.maxResults.default, 10);
  });
});
