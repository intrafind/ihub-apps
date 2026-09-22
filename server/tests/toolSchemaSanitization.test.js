/**
 * Cross-converter tool-schema sanitization tests.
 *
 * Each tool-calling converter owns its own `sanitizeSchema()`, all built on the
 * shared `cloneAndWalkSchema()` helper. These tests lock in the two things that
 * must hold for every converter:
 *
 * 1. The `properties`-container guard: a tool parameter literally NAMED after a
 *    schema keyword (`title`, `format`, `additionalProperties`, ...) must never
 *    be deleted, or `required` ends up pointing at a property that no longer
 *    exists and the provider rejects the whole request.
 * 2. The input schema is never mutated in place — callers reuse tool definitions
 *    across requests and providers.
 *
 * Provider-specific keyword stripping is asserted per converter below.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as OpenAIConverter from '../adapters/toolCalling/OpenAIConverter.js';
import * as OpenAIResponsesConverter from '../adapters/toolCalling/OpenAIResponsesConverter.js';
import * as AnthropicConverter from '../adapters/toolCalling/AnthropicConverter.js';
import * as MistralConverter from '../adapters/toolCalling/MistralConverter.js';
import * as GoogleConverter from '../adapters/toolCalling/GoogleConverter.js';
import * as VLLMConverter from '../adapters/toolCalling/VLLMConverter.js';
import { convertGenericToolsToBedrock } from '../adapters/toolCalling/BedrockConverter.js';

/** Every converter that exports its own `sanitizeSchema`. */
const CONVERTERS = [
  ['openai', OpenAIConverter],
  ['openai-responses', OpenAIResponsesConverter],
  ['anthropic', AnthropicConverter],
  ['mistral', MistralConverter],
  ['google', GoogleConverter],
  ['vllm', VLLMConverter]
];

/**
 * A schema whose property names collide with schema keywords the converters
 * strip. A fixture with plain `{ type: 'string' }` properties passes with or
 * without the guard, so it would not discriminate.
 */
function keywordNamedPropertiesSchema() {
  return {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'The document title' },
      format: { type: 'string', description: 'Export format' },
      additionalProperties: { type: 'boolean' },
      minLength: { type: 'integer' }
    },
    required: ['title', 'format', 'additionalProperties', 'minLength']
  };
}

describe('tool schema sanitization — shared invariants', () => {
  for (const [name, converter] of CONVERTERS) {
    it(`${name}: keeps properties literally named after schema keywords`, () => {
      const sanitized = converter.sanitizeSchema(keywordNamedPropertiesSchema());

      assert.deepEqual(
        Object.keys(sanitized.properties).sort(),
        ['additionalProperties', 'format', 'minLength', 'title'],
        `${name} dropped a property whose name collides with a schema keyword`
      );
    });

    it(`${name}: leaves no 'required' entry pointing at a missing property`, () => {
      const sanitized = converter.sanitizeSchema(keywordNamedPropertiesSchema());

      for (const key of sanitized.required ?? []) {
        assert.ok(
          Object.hasOwn(sanitized.properties, key),
          `${name}: required lists '${key}' but it is not in properties`
        );
      }
    });

    it(`${name}: does not mutate the input schema`, () => {
      const input = keywordNamedPropertiesSchema();
      converter.sanitizeSchema(input);

      assert.deepEqual(input, keywordNamedPropertiesSchema());
    });

    it(`${name}: returns an empty object schema for a missing/invalid schema`, () => {
      assert.deepEqual(converter.sanitizeSchema(undefined), { type: 'object', properties: {} });
      assert.deepEqual(converter.sanitizeSchema(null), { type: 'object', properties: {} });
      assert.deepEqual(converter.sanitizeSchema('nope'), { type: 'object', properties: {} });
    });
  }

  it('bedrock: reuses Anthropic sanitization and keeps keyword-named properties', () => {
    const [tool] = convertGenericToolsToBedrock([
      {
        id: 'exporter',
        name: 'exporter',
        description: 'd',
        parameters: keywordNamedPropertiesSchema()
      }
    ]);

    assert.deepEqual(
      tool.toolSpec.inputSchema.json,
      AnthropicConverter.sanitizeSchema(keywordNamedPropertiesSchema())
    );
    assert.deepEqual(Object.keys(tool.toolSpec.inputSchema.json.properties).sort(), [
      'additionalProperties',
      'format',
      'minLength',
      'title'
    ]);
  });
});

describe('tool schema sanitization — provider-specific stripping', () => {
  it('google: strips the keywords Gemini rejects, on schema nodes only', () => {
    const sanitized = GoogleConverter.sanitizeSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      title: 'Search',
      additionalProperties: false,
      properties: {
        q: { type: 'string', title: 'Query', format: 'uri', minLength: 2, maxLength: 9 }
      }
    });

    assert.equal(sanitized.$schema, undefined);
    assert.equal(sanitized.title, undefined);
    assert.equal(sanitized.additionalProperties, undefined);
    assert.deepEqual(sanitized.properties.q, { type: 'string' });
  });

  it('google: flattens a multilingual description to a plain string', () => {
    const sanitized = GoogleConverter.sanitizeSchema({
      type: 'object',
      properties: { q: { type: 'string', description: { en: 'Query', de: 'Suche' } } }
    });

    assert.equal(sanitized.properties.q.description, 'Query');
  });

  it('vllm: strips format/title/exclusive bounds but keeps minLength/maxLength', () => {
    const sanitized = VLLMConverter.sanitizeSchema({
      type: 'object',
      properties: {
        q: {
          type: 'string',
          title: 'Query',
          format: 'uri',
          minLength: 2,
          maxLength: 9
        },
        n: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 10 }
      }
    });

    assert.deepEqual(sanitized.properties.q, { type: 'string', minLength: 2, maxLength: 9 });
    assert.deepEqual(sanitized.properties.n, { type: 'number' });
  });

  for (const name of ['openai', 'openai-responses', 'anthropic', 'mistral']) {
    const converter = CONVERTERS.find(([n]) => n === name)[1];

    it(`${name}: passes a schema through unchanged`, () => {
      const input = {
        type: 'object',
        title: 'Search',
        additionalProperties: false,
        properties: { q: { type: 'string', format: 'uri', minLength: 2 } },
        required: ['q']
      };

      assert.deepEqual(converter.sanitizeSchema(input), input);
    });
  }
});
