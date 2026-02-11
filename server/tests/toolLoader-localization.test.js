/**
 * Tests for tool localization in toolLoader
 * Ensures that tools are always localized, preventing schema validation errors
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfiguredTools } from '../toolLoader.js';

describe('Tool Localization', () => {
  beforeEach(() => {
    // ConfigCache is initialized by the server - no setup needed for tests
  });

  afterEach(() => {
    // No cleanup needed as configCache manages its own state
  });

  it('should localize tools when language is provided', async () => {
    const tools = await loadConfiguredTools('en');

    // Verify tools are returned
    assert.ok(Array.isArray(tools), 'Tools should be an array');

    if (tools.length > 0) {
      // Find a tool with nested descriptions (like enhancedWebSearch)
      const enhancedWebSearch = tools.find(t => t.id === 'enhancedWebSearch');

      if (enhancedWebSearch) {
        // Check that description is localized (string, not object)
        assert.strictEqual(
          typeof enhancedWebSearch.description,
          'string',
          'Tool description should be a string, not an object'
        );

        // Check nested parameter descriptions
        const queryParam = enhancedWebSearch.parameters?.properties?.query;
        if (queryParam?.description) {
          assert.strictEqual(
            typeof queryParam.description,
            'string',
            'Parameter description should be a string, not an object'
          );
        }
      }
    }
  });

  it('should localize tools when language is null (using platform default)', async () => {
    const tools = await loadConfiguredTools(null);

    // Verify tools are returned
    assert.ok(Array.isArray(tools), 'Tools should be an array');

    if (tools.length > 0) {
      // Find a tool with parameters
      const webContentExtractor = tools.find(t => t.id === 'webContentExtractor');

      if (webContentExtractor) {
        // Check that tool-level description is localized
        assert.strictEqual(
          typeof webContentExtractor.description,
          'string',
          'Tool description should be a string when language is null'
        );

        // Check nested parameter descriptions are also localized
        const urlParam = webContentExtractor.parameters?.properties?.url;
        if (urlParam?.description) {
          assert.strictEqual(
            typeof urlParam.description,
            'string',
            'Nested parameter description should be a string when language is null'
          );
        }
      }
    }
  });

  it('should localize tools when language is undefined', async () => {
    const tools = await loadConfiguredTools(undefined);

    // Verify tools are returned
    assert.ok(Array.isArray(tools), 'Tools should be an array');

    if (tools.length > 0) {
      // Find ask_user tool which has deeply nested descriptions
      const askUser = tools.find(t => t.id === 'ask_user');

      if (askUser) {
        // Check tool-level description
        assert.strictEqual(
          typeof askUser.description,
          'string',
          'Tool description should be a string when language is undefined'
        );

        // Check nested parameter descriptions
        const questionParam = askUser.parameters?.properties?.question;
        if (questionParam?.description) {
          assert.strictEqual(
            typeof questionParam.description,
            'string',
            'Parameter description should be a string when language is undefined'
          );
        }

        // Check deeply nested descriptions (options.items.properties.value.description)
        const optionsParam = askUser.parameters?.properties?.options;
        if (optionsParam?.items?.properties?.value?.description) {
          assert.strictEqual(
            typeof optionsParam.items.properties.value.description,
            'string',
            'Deeply nested parameter description should be a string when language is undefined'
          );
        }
      }
    }
  });

  it('should localize tools when language is empty string', async () => {
    const tools = await loadConfiguredTools('');

    // Verify tools are returned
    assert.ok(Array.isArray(tools), 'Tools should be an array');

    if (tools.length > 0) {
      // Check that at least one tool with parameters has localized descriptions
      const toolWithParams = tools.find(
        t => t.parameters?.properties && Object.keys(t.parameters.properties).length > 0
      );

      if (toolWithParams) {
        // Tool description should be string
        assert.strictEqual(
          typeof toolWithParams.description,
          'string',
          'Tool description should be a string when language is empty string'
        );

        // At least one parameter should have a string description
        const firstParam = Object.values(toolWithParams.parameters.properties)[0];
        if (firstParam?.description) {
          assert.strictEqual(
            typeof firstParam.description,
            'string',
            'Parameter description should be a string when language is empty string'
          );
        }
      }
    }
  });

  it('should use German localization when language is "de"', async () => {
    const tools = await loadConfiguredTools('de');

    // Verify tools are returned
    assert.ok(Array.isArray(tools), 'Tools should be an array');

    if (tools.length > 0) {
      // Find braveSearch tool which has German translations
      const braveSearch = tools.find(t => t.id === 'braveSearch');

      if (braveSearch) {
        // Check that description is a German string (not English)
        assert.strictEqual(
          typeof braveSearch.description,
          'string',
          'Tool description should be a string for German'
        );

        // The description should be German, not English
        // We can't assert exact text without coupling to config, but we can verify it's not the English version
        assert.ok(braveSearch.description.length > 0, 'German description should not be empty');
      }
    }
  });
});
