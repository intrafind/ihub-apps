/**
 * Test for Gemini 3 thoughtSignature handling in multi-turn tool calling conversations
 * 
 * This test validates the fix for the issue where Gemini 3 models with thinking enabled
 * require thoughtSignature to be preserved and passed back in continuation requests.
 */

import assert from 'assert';
import { convertGoogleResponseToGeneric } from '../adapters/toolCalling/GoogleConverter.js';
import GoogleAdapter from '../adapters/google.js';

describe('Gemini ThoughtSignature Handling', () => {
  describe('Response Parsing', () => {
    it('should extract thoughtSignature from function call and include in tool call metadata', () => {
      // Simulate a Gemini 3 response with thinking enabled and a function call
      const geminiResponse = JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'enhancedWebSearch',
                    args: { query: 'test query' }
                  },
                  thoughtSignature: 'AgQKA...' // Example signature
                }
              ],
              role: 'model'
            },
            finishReason: 'STOP'
          }
        ]
      });

      const result = convertGoogleResponseToGeneric(geminiResponse, 'default');

      // Verify tool call was created
      assert.strictEqual(result.tool_calls.length, 1, 'Should have one tool call');
      assert.strictEqual(result.tool_calls[0].name, 'enhancedWebSearch', 'Tool name should match');
      
      // Verify thoughtSignature is preserved in metadata
      assert.ok(result.tool_calls[0].metadata, 'Tool call should have metadata');
      assert.strictEqual(
        result.tool_calls[0].metadata.thoughtSignature,
        'AgQKA...',
        'thoughtSignature should be in metadata'
      );

      // Verify backward compatibility - thoughtSignatures array should also exist
      assert.ok(result.thoughtSignatures, 'Should have thoughtSignatures array for backward compatibility');
      assert.strictEqual(result.thoughtSignatures.length, 1, 'Should have one thoughtSignature');
      assert.strictEqual(result.thoughtSignatures[0], 'AgQKA...', 'thoughtSignature should match');
    });

    it('should handle multiple tool calls with their respective thoughtSignatures', () => {
      const geminiResponse = JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'tool1',
                    args: { param: 'value1' }
                  },
                  thoughtSignature: 'signature1'
                },
                {
                  functionCall: {
                    name: 'tool2',
                    args: { param: 'value2' }
                  },
                  thoughtSignature: 'signature2'
                }
              ],
              role: 'model'
            },
            finishReason: 'STOP'
          }
        ]
      });

      const result = convertGoogleResponseToGeneric(geminiResponse, 'default');

      assert.strictEqual(result.tool_calls.length, 2, 'Should have two tool calls');
      assert.strictEqual(
        result.tool_calls[0].metadata.thoughtSignature,
        'signature1',
        'First tool call should have first signature'
      );
      assert.strictEqual(
        result.tool_calls[1].metadata.thoughtSignature,
        'signature2',
        'Second tool call should have second signature'
      );
    });

    it('should handle function calls without thoughtSignature gracefully', () => {
      const geminiResponse = JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'testTool',
                    args: { query: 'test' }
                  }
                  // No thoughtSignature field
                }
              ],
              role: 'model'
            },
            finishReason: 'STOP'
          }
        ]
      });

      const result = convertGoogleResponseToGeneric(geminiResponse, 'default');

      assert.strictEqual(result.tool_calls.length, 1, 'Should have one tool call');
      assert.ok(result.tool_calls[0].metadata, 'Should have metadata object');
      assert.strictEqual(
        result.tool_calls[0].metadata.thoughtSignature,
        undefined,
        'thoughtSignature should be undefined when not present'
      );
    });
  });

  describe('Message Formatting', () => {
    it('should include thoughtSignature when formatting assistant message with tool calls', () => {
      // Create an assistant message with tool calls that have thoughtSignature metadata
      const messages = [
        { role: 'user', content: 'test query' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'enhancedWebSearch',
                arguments: '{"query":"test"}'
              },
              metadata: {
                originalFormat: 'google',
                thoughtSignature: 'AgQKA...'
              }
            }
          ]
        }
      ];

      const { contents } = GoogleAdapter.formatMessages(messages);

      // Find the model message with function call
      const modelMessage = contents.find(msg => msg.role === 'model');
      assert.ok(modelMessage, 'Should have a model message');

      // Find the function call part
      const functionCallPart = modelMessage.parts.find(part => part.functionCall);
      assert.ok(functionCallPart, 'Should have a function call part');
      assert.strictEqual(
        functionCallPart.thoughtSignature,
        'AgQKA...',
        'thoughtSignature should be included in function call part'
      );
    });

    it('should handle tool calls without thoughtSignature in metadata', () => {
      const messages = [
        { role: 'user', content: 'test query' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'testTool',
                arguments: '{"query":"test"}'
              },
              metadata: {
                originalFormat: 'google'
                // No thoughtSignature
              }
            }
          ]
        }
      ];

      const { contents } = GoogleAdapter.formatMessages(messages);
      const modelMessage = contents.find(msg => msg.role === 'model');
      const functionCallPart = modelMessage.parts.find(part => part.functionCall);

      assert.ok(functionCallPart, 'Should have a function call part');
      assert.strictEqual(
        functionCallPart.thoughtSignature,
        undefined,
        'thoughtSignature should not be present when not in metadata'
      );
    });

    it('should handle tool calls without metadata object', () => {
      const messages = [
        { role: 'user', content: 'test query' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'testTool',
                arguments: '{"query":"test"}'
              }
              // No metadata at all
            }
          ]
        }
      ];

      const { contents } = GoogleAdapter.formatMessages(messages);
      const modelMessage = contents.find(msg => msg.role === 'model');
      const functionCallPart = modelMessage.parts.find(part => part.functionCall);

      assert.ok(functionCallPart, 'Should have a function call part');
      assert.strictEqual(
        functionCallPart.thoughtSignature,
        undefined,
        'thoughtSignature should not be present when metadata is missing'
      );
    });
  });

  describe('Multi-turn Conversation Flow', () => {
    it('should preserve thoughtSignature through complete conversation cycle', () => {
      // Step 1: Parse initial response with thoughtSignature
      const initialResponse = JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'enhancedWebSearch',
                    args: { query: 'test' }
                  },
                  thoughtSignature: 'initial_signature'
                }
              ],
              role: 'model'
            },
            finishReason: 'STOP'
          }
        ]
      });

      const parsedResult = convertGoogleResponseToGeneric(initialResponse, 'default');

      // Step 2: Create assistant message with the tool call (simulating ToolExecutor)
      const assistantMessage = {
        role: 'assistant',
        content: null,
        tool_calls: parsedResult.tool_calls
      };

      // Step 3: Add tool response
      const messages = [
        { role: 'user', content: 'search for test' },
        assistantMessage,
        {
          role: 'tool',
          tool_call_id: parsedResult.tool_calls[0].id,
          name: 'enhancedWebSearch',
          content: JSON.stringify({ result: 'test results' })
        }
      ];

      // Step 4: Format messages for next API call
      const { contents } = GoogleAdapter.formatMessages(messages);

      // Verify the model message includes thoughtSignature
      const modelMessage = contents.find(msg => msg.role === 'model');
      const functionCallPart = modelMessage?.parts.find(part => part.functionCall);

      assert.ok(functionCallPart, 'Should have function call part');
      assert.strictEqual(
        functionCallPart.thoughtSignature,
        'initial_signature',
        'thoughtSignature should be preserved through the conversation cycle'
      );
    });
  });
});
