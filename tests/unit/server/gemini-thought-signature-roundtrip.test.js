/**
 * Regression coverage for Gemini thought signatures crossing the
 * OpenAI-compatible boundary (server/routes/openaiProxy.js).
 *
 * The bug: an external caller hitting /api/inference/v1/chat/completions with a
 * Google model and tools got the first tool call fine, then Gemini rejected the
 * follow-up request carrying the tool result with
 *
 *   400 ... Function call is missing a thought_signature in functionCall parts.
 *
 * Gemini 3 attaches a thought signature to the FIRST functionCall part of a
 * response — parallel calls after it carry none — and validates that it comes
 * back for the function calls of the current turn. The OpenAI tool-call schema
 * has no field for it, so the proxy dropped it on the way out and had nothing to
 * send back.
 *
 * The contract pinned here:
 *   - the signature leaves as `extra_content.google.thought_signature`, the
 *     location Google's own OpenAI-compatibility layer uses
 *   - it is read back out of that field (and the flat variants clients use) and
 *     lands on the Gemini functionCall part it came from
 *   - a caller that dropped the field gets the documented skip sentinel rather
 *     than a 400 — decided on the first functionCall part itself, since a
 *     Gemini 2.5 text-part signature does not satisfy Gemini 3
 *   - only the first of several parallel calls is signed, and previous turns are
 *     left exactly as they were
 *   - the field is stripped again on the way to a non-Gemini model, which would
 *     otherwise reject the request for carrying it
 *
 * @see https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
 */

import { describe, it, expect, jest } from '@jest/globals';

// pathUtils resolves the app root via import.meta.url, which babel-jest's CJS
// transform cannot express — stub it with an equivalent that works under jest.
// It is reached through localize.js -> configCache.js -> configLoader.js.
jest.mock('../../../server/pathUtils.js', () => ({
  getRootDir: () => require('path').join(__dirname, '../../../')
}));

// configCache drags in the whole config/auth loading stack (more import.meta
// modules). Message formatting never touches configuration.
jest.mock('../../../server/configCache.js', () => ({
  default: {
    getPlatform: () => ({}),
    getModels: () => ({ data: [] })
  }
}));

// openai.js reaches ModelDiscoveryService -> requestThrottler -> httpConfig ->
// node-fetch, which is ESM-only in node_modules and cannot be loaded through
// jest's CJS transform. None of it is touched by message formatting.
jest.mock('../../../server/services/ModelDiscoveryService.js', () => ({ default: {} }));
jest.mock('../../../server/requestThrottler.js', () => ({ throttledFetch: jest.fn() }));
jest.mock('../../../server/utils/httpConfig.js', () => ({
  getSSLConfig: jest.fn(() => ({})),
  getProxyConfig: jest.fn(() => ({})),
  createAgent: jest.fn(),
  enhanceFetchOptions: jest.fn(options => options),
  httpFetch: jest.fn()
}));

import {
  convertGenericToolCallsToOpenAI,
  convertOpenAIToolCallsToGeneric
} from '../../../server/adapters/toolCalling/OpenAIConverter.js';
import {
  convertGenericResponseToGoogle,
  convertGoogleResponseToGeneric
} from '../../../server/adapters/toolCalling/GoogleConverter.js';
import {
  THOUGHT_SIGNATURE_SKIP_SENTINEL,
  modelConsumesThoughtSignature
} from '../../../server/adapters/toolCalling/thoughtSignatures.js';
import GoogleAdapter from '../../../server/adapters/google.js';
import OpenAIAdapter from '../../../server/adapters/openai.js';
import MistralAdapter from '../../../server/adapters/mistral.js';

const SIGNATURE = 'ErUBCsIBAcu98PBcCK...';

/** A Gemini response carrying one function call plus its thought signature. */
function geminiToolCallResponse({ signature = SIGNATURE, name = 'get_weather' } = {}) {
  return JSON.stringify({
    candidates: [
      {
        content: {
          parts: [
            {
              functionCall: { name, args: { city: 'Berlin' } },
              ...(signature ? { thoughtSignature: signature } : {})
            }
          ],
          role: 'model'
        },
        finishReason: 'STOP'
      }
    ]
  });
}

function firstFunctionCallPart(contents) {
  return contents.flatMap(entry => entry.parts || []).find(part => part.functionCall);
}

describe('Gemini thought signatures over the OpenAI-compatible surface', () => {
  it('carries the signature out to the client as extra_content', async () => {
    const generic = await convertGoogleResponseToGeneric(geminiToolCallResponse(), 'stream-1');
    expect(generic.tool_calls).toHaveLength(1);

    const [toolCall] = convertGenericToolCallsToOpenAI(generic.tool_calls);

    expect(toolCall.extra_content).toEqual({ google: { thought_signature: SIGNATURE } });
    // The rest of the tool call must stay standard OpenAI shape.
    expect(toolCall.type).toBe('function');
    expect(toolCall.function.name).toBe('get_weather');
  });

  it('omits extra_content when the provider returned no signature', () => {
    const [toolCall] = convertGenericToolCallsToOpenAI([
      {
        id: 'call_0',
        name: 'someTool',
        arguments: {},
        index: 0,
        metadata: { originalFormat: 'openai' }
      }
    ]);

    expect(toolCall.extra_content).toBeUndefined();
  });

  it('reads an echoed extra_content signature back into generic metadata', () => {
    const [generic] = convertOpenAIToolCallsToGeneric([
      {
        id: 'call_0',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Berlin"}' },
        extra_content: { google: { thought_signature: SIGNATURE } }
      }
    ]);

    expect(generic.metadata.thoughtSignature).toBe(SIGNATURE);
  });

  it('sends an echoed signature back to Gemini on the part it came from', () => {
    // Exactly what a cooperative caller posts back: the assistant message it
    // received from /api/inference, unchanged, plus the tool result.
    const { contents } = GoogleAdapter.formatMessages([
      { role: 'user', content: 'What is the weather in Berlin?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_0',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Berlin"}' },
            extra_content: { google: { thought_signature: SIGNATURE } }
          }
        ]
      },
      {
        role: 'tool',
        tool_call_id: 'call_0',
        name: 'get_weather',
        content: JSON.stringify({ tempC: 21 })
      }
    ]);

    expect(firstFunctionCallPart(contents).thoughtSignature).toBe(SIGNATURE);

    // The tool result has to follow the model turn as its own functionResponse
    // content — Gemini rejects interleaved call/response ordering.
    const modelTurnIndex = contents.findIndex(entry => entry.role === 'model');
    expect(contents[modelTurnIndex + 1].parts.some(part => part.functionResponse)).toBe(true);
  });

  it('accepts the flat thought_signature variant some clients emit', () => {
    const { contents } = GoogleAdapter.formatMessages([
      { role: 'user', content: 'What is the weather in Berlin?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_0',
            type: 'function',
            function: { name: 'get_weather', arguments: '{}' },
            thought_signature: SIGNATURE
          }
        ]
      }
    ]);

    expect(firstFunctionCallPart(contents).thoughtSignature).toBe(SIGNATURE);
  });

  it('substitutes the skip sentinel when the caller dropped the signature', () => {
    // Strict OpenAI SDKs discard unknown fields, so extra_content never returns.
    // Without a stand-in Gemini 3 fails the whole request with a 400.
    const { contents } = GoogleAdapter.formatMessages([
      { role: 'user', content: 'What is the weather in Berlin?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_0',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Berlin"}' }
          }
        ]
      },
      {
        role: 'tool',
        tool_call_id: 'call_0',
        name: 'get_weather',
        content: JSON.stringify({ tempC: 21 })
      }
    ]);

    expect(firstFunctionCallPart(contents).thoughtSignature).toBe(THOUGHT_SIGNATURE_SKIP_SENTINEL);
  });

  it('signs only the first of several parallel function calls', () => {
    const { contents } = GoogleAdapter.formatMessages([
      { role: 'user', content: 'Weather in Berlin and Hamburg?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_0',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Berlin"}' },
            extra_content: { google: { thought_signature: SIGNATURE } }
          },
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Hamburg"}' }
          }
        ]
      }
    ]);

    const parts = contents
      .flatMap(entry => entry.parts || [])
      .filter(part => part.functionCall)
      .map(part => part.thoughtSignature);

    expect(parts).toEqual([SIGNATURE, undefined]);
  });

  it('leaves function calls from previous turns untouched', () => {
    // Gemini only validates the current turn — the one opening at the most
    // recent user message with real content. Older calls must go back as they
    // were, without invented signatures.
    const { contents } = GoogleAdapter.formatMessages([
      { role: 'user', content: 'first question' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_old', type: 'function', function: { name: 'oldTool', arguments: '{}' } }
        ]
      },
      { role: 'tool', tool_call_id: 'call_old', name: 'oldTool', content: '{"ok":true}' },
      { role: 'assistant', content: 'here you go' },
      { role: 'user', content: 'second question' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_new', type: 'function', function: { name: 'newTool', arguments: '{}' } }
        ]
      }
    ]);

    const signatures = contents
      .flatMap(entry => entry.parts || [])
      .filter(part => part.functionCall)
      .map(part => part.thoughtSignature);

    expect(signatures).toEqual([undefined, THOUGHT_SIGNATURE_SKIP_SENTINEL]);
  });

  it('signs the first function call even when only the text part carried a signature', () => {
    // Gemini 2.5 places its signature on the first part whatever the type, so a
    // text part can legitimately hold one while the function call holds none.
    // That does NOT satisfy Gemini 3, which validates the first functionCall
    // part specifically — treating any-part-signed as good enough left the call
    // unsigned and still produced the 400.
    const { contents } = GoogleAdapter.formatMessages([
      { role: 'user', content: 'do a thing' },
      {
        role: 'assistant',
        content: 'Let me look that up.',
        thoughtSignatures: [SIGNATURE],
        tool_calls: [
          { id: 'call_0', type: 'function', function: { name: 'search', arguments: '{}' } }
        ]
      }
    ]);

    const modelMessage = contents.find(m => m.role === 'model');
    const textPart = modelMessage.parts.find(part => part.text);
    const functionCallPart = modelMessage.parts.find(part => part.functionCall);

    // The text part keeps the real signature it was given...
    expect(textPart.thoughtSignature).toBe(SIGNATURE);
    // ...and the function call still gets a signature of its own.
    expect(functionCallPart.thoughtSignature).toBe(THOUGHT_SIGNATURE_SKIP_SENTINEL);
  });

  it('treats a whitespace-only user message as a turn boundary', () => {
    // GoogleAdapter forwards any truthy string as a real { text } user part, so
    // Gemini sees it as the standard content that opens a turn. If the boundary
    // scan skipped it, the turn would start at the earlier user message and
    // sentinels would leak into the previous turn's function calls.
    const { contents } = GoogleAdapter.formatMessages([
      { role: 'user', content: 'first question' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_old', type: 'function', function: { name: 'oldTool', arguments: '{}' } }
        ]
      },
      { role: 'tool', tool_call_id: 'call_old', name: 'oldTool', content: '{"ok":true}' },
      { role: 'user', content: '   ' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_new', type: 'function', function: { name: 'newTool', arguments: '{}' } }
        ]
      }
    ]);

    const signatures = contents
      .flatMap(entry => entry.parts || [])
      .filter(part => part.functionCall)
      .map(part => part.thoughtSignature);

    expect(signatures).toEqual([undefined, THOUGHT_SIGNATURE_SKIP_SENTINEL]);
  });

  it('preserves the signature through convertGenericResponseToGoogle', () => {
    // Every public Google conversion path has to keep it, not just the hot one.
    const response = convertGenericResponseToGoogle({
      content: [],
      tool_calls: [
        {
          id: 'call_0',
          name: 'get_weather',
          arguments: { city: 'Berlin' },
          index: 0,
          metadata: { originalFormat: 'google', thoughtSignature: SIGNATURE }
        }
      ],
      finishReason: 'tool_calls'
    });

    const part = response.candidates[0].content.parts.find(p => p.functionCall);
    expect(part.thoughtSignature).toBe(SIGNATURE);
  });

  // Hermes Agent documents why this matters: Gemini requires extra_content on
  // replayed tool calls, while "every other strict OpenAI-compatible provider
  // (Fireworks, Mistral, ...) rejects the request with 400 if extra_content *is*
  // present". Now that iHub emits the field, a caller replaying that history
  // against a non-Gemini model must not have it forwarded upstream.
  describe('cross-provider replay guard', () => {
    const geminiToolCallMessage = [
      { role: 'user', content: 'What is the weather in Berlin?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_0',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Berlin"}' },
            extra_content: { google: { thought_signature: SIGNATURE } }
          }
        ]
      }
    ];

    it('identifies which models consume thought signatures', () => {
      expect(modelConsumesThoughtSignature({ id: 'gemini-flash-latest' })).toBe(true);
      expect(modelConsumesThoughtSignature({ id: 'gemma-3-27b' })).toBe(true);
      // An alias whose wire name is still Gemini, e.g. the openai adapter
      // pointed at Gemini's OpenAI-compatible endpoint.
      expect(modelConsumesThoughtSignature({ id: 'fast', modelId: 'gemini-3-pro' })).toBe(true);
      expect(
        modelConsumesThoughtSignature({
          id: 'fast',
          url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
        })
      ).toBe(true);

      expect(modelConsumesThoughtSignature({ id: 'gpt-4o' })).toBe(false);
      expect(modelConsumesThoughtSignature({ id: 'mistral-large-latest' })).toBe(false);
      expect(modelConsumesThoughtSignature(undefined)).toBe(false);
    });

    it('strips extra_content when forwarding to a non-Gemini OpenAI model', () => {
      const formatted = OpenAIAdapter.formatMessages(geminiToolCallMessage, { id: 'gpt-4o' });
      const [toolCall] = formatted.find(m => m.tool_calls).tool_calls;

      expect(toolCall.extra_content).toBeUndefined();
      // Everything else has to survive untouched.
      expect(toolCall.id).toBe('call_0');
      expect(toolCall.function).toEqual({ name: 'get_weather', arguments: '{"city":"Berlin"}' });
    });

    it('strips extra_content when forwarding to Mistral', () => {
      const formatted = MistralAdapter.formatMessages(geminiToolCallMessage, {
        id: 'mistral-large-latest'
      });
      const [toolCall] = formatted.find(m => m.tool_calls).tool_calls;

      expect(toolCall.extra_content).toBeUndefined();
    });

    it('keeps extra_content for the openai adapter pointed at Gemini', () => {
      const formatted = OpenAIAdapter.formatMessages(geminiToolCallMessage, {
        id: 'gemini-3-pro-compat',
        url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
      });
      const [toolCall] = formatted.find(m => m.tool_calls).tool_calls;

      expect(toolCall.extra_content).toEqual({ google: { thought_signature: SIGNATURE } });
    });

    it("does not mutate the caller's messages while stripping", () => {
      const messages = JSON.parse(JSON.stringify(geminiToolCallMessage));
      OpenAIAdapter.formatMessages(messages, { id: 'gpt-4o' });

      expect(messages[1].tool_calls[0].extra_content).toEqual({
        google: { thought_signature: SIGNATURE }
      });
    });
  });

  it('keeps a tool result turn inside the current turn', () => {
    // A functionResponse is not a turn boundary, so the model turn that follows
    // one is still current and still needs a signature.
    const { contents } = GoogleAdapter.formatMessages([
      { role: 'user', content: 'check the flight and book a taxi if delayed' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_0',
            type: 'function',
            function: { name: 'check_flight', arguments: '{}' },
            extra_content: { google: { thought_signature: SIGNATURE } }
          }
        ]
      },
      { role: 'tool', tool_call_id: 'call_0', name: 'check_flight', content: '{"delayed":true}' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'book_taxi', arguments: '{}' } }
        ]
      }
    ]);

    const signatures = contents
      .flatMap(entry => entry.parts || [])
      .filter(part => part.functionCall)
      .map(part => part.thoughtSignature);

    expect(signatures).toEqual([SIGNATURE, THOUGHT_SIGNATURE_SKIP_SENTINEL]);
  });
});
