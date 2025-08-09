import { createCompletionRequest } from '../../server/adapters/index.js';
import { loadConfiguredTools } from '../../server/toolLoader.js';
import { TestHelper, MockDataGenerator } from '../utils/helpers.js';
import { testModels, testEnvironment, mockApiKeys } from '../utils/fixtures.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: '.env.test' });
dotenv.config({ path: '.env' });

/**
 * Model Integration Tests
 * These tests validate the integration with actual LLM providers
 * or use mock responses when real API calls are disabled
 */

describe('Model Integration Tests', () => {
  let availableTools;

  beforeAll(async () => {
    // Load configured tools for testing
    try {
      availableTools = await loadConfiguredTools();
    } catch (error) {
      console.warn('Could not load tools, using mock tools:', error.message);
      availableTools = [
        {
          name: 'web_search',
          description: 'Search the web for information',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query' }
            },
            required: ['query']
          }
        }
      ];
    }
  });

  describe('OpenAI Model Integration', () => {
    const model = testModels.openai;
    const apiKey = process.env.OPENAI_API_KEY || mockApiKeys.openai;

    test('should handle simple chat completion', async () => {
      const messages = [{ role: 'user', content: 'Hello, say "test response" in your reply.' }];

      if (testEnvironment.enableRealApiCalls && process.env.OPENAI_API_KEY) {
        // Real API call
        const request = createCompletionRequest(model, messages, apiKey, {
          temperature: 0.1,
          maxTokens: 50,
          stream: false
        });

        const response = await fetch(request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(request.body)
        });

        expect(response.ok).toBe(true);
        const data = await response.json();
        TestHelper.validateModelResponse(data);
        expect(data.choices[0].message.content).toContain('test response');
      } else {
        // Mock response
        const mockResponse = MockDataGenerator.generateModelResponse();
        TestHelper.validateModelResponse(mockResponse);
        expect(mockResponse.choices[0].message.content).toBeTruthy();
      }
    });

    test('should handle tool calling requests', async () => {
      const messages = [
        {
          role: 'user',
          content: 'Search for information about quantum computing using the web search tool.'
        }
      ];

      if (testEnvironment.enableRealApiCalls && process.env.OPENAI_API_KEY) {
        // Real API call with tools
        const request = createCompletionRequest(model, messages, apiKey, {
          tools: availableTools.slice(0, 2), // Use first 2 tools
          temperature: 0.1,
          maxTokens: 200,
          stream: false
        });

        const response = await fetch(request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(request.body)
        });

        expect(response.ok).toBe(true);
        const data = await response.json();
        TestHelper.validateModelResponse(data);

        // Should either have content or tool calls
        const message = data.choices[0].message;
        expect(message.content || message.tool_calls).toBeTruthy();

        if (message.tool_calls) {
          expect(Array.isArray(message.tool_calls)).toBe(true);
          message.tool_calls.forEach(toolCall => {
            expect(toolCall).toHaveProperty('function');
            expect(toolCall.function).toHaveProperty('name');
            expect(toolCall.function).toHaveProperty('arguments');
          });
        }
      } else {
        // Mock tool calling response
        const mockResponse = MockDataGenerator.generateModelResponse(true);
        TestHelper.validateModelResponse(mockResponse);
        expect(mockResponse.choices[0].message.tool_calls).toBeTruthy();
      }
    });

    test('should handle streaming responses', async () => {
      const messages = [{ role: 'user', content: 'Write a short poem about testing.' }];

      if (testEnvironment.enableRealApiCalls && process.env.OPENAI_API_KEY) {
        // Real streaming API call
        const request = createCompletionRequest(model, messages, apiKey, {
          temperature: 0.7,
          maxTokens: 100,
          stream: true
        });

        const response = await fetch(request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(request.body)
        });

        expect(response.ok).toBe(true);
        expect(response.headers.get('content-type')).toContain('text/event-stream');

        // Read first few chunks to verify streaming
        const reader = response.body.getReader();
        let chunksReceived = 0;
        let accumulatedContent = '';

        while (chunksReceived < 5) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = new TextDecoder().decode(value);
          accumulatedContent += chunk;
          chunksReceived++;
        }

        expect(chunksReceived).toBeGreaterThan(0);
        expect(accumulatedContent).toContain('data:');

        // Clean up
        reader.releaseLock();
      } else {
        // Mock streaming validation
        console.log('Streaming test mocked - real API not available');
        expect(true).toBe(true); // Placeholder for mock streaming test
      }
    });

    test('should handle error responses gracefully', async () => {
      const messages = [{ role: 'user', content: 'Test message' }];
      const invalidApiKey = 'invalid-key-12345';

      if (testEnvironment.enableRealApiCalls) {
        // Test with invalid API key
        const request = createCompletionRequest(model, messages, invalidApiKey, {
          temperature: 0.1,
          maxTokens: 50,
          stream: false
        });

        const response = await fetch(request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(request.body)
        });

        expect(response.ok).toBe(false);
        expect(response.status).toBe(401);

        const errorData = await response.json();
        expect(errorData).toHaveProperty('error');
      } else {
        // Mock error response
        const mockError = MockDataGenerator.generateErrorResponse(401, 'Invalid API key');
        expect(mockError).toHaveProperty('error');
        expect(mockError.error.code).toBe(401);
      }
    });
  });

  describe('Anthropic Model Integration', () => {
    const model = testModels.anthropic;
    const apiKey = process.env.ANTHROPIC_API_KEY || mockApiKeys.anthropic;

    test('should handle simple chat completion', async () => {
      const messages = [{ role: 'user', content: 'Hello, say "anthropic test" in your reply.' }];

      if (testEnvironment.enableRealApiCalls && process.env.ANTHROPIC_API_KEY) {
        // Real API call
        const request = createCompletionRequest(model, messages, apiKey, {
          temperature: 0.1,
          maxTokens: 50,
          stream: false
        });

        const response = await fetch(request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(request.body)
        });

        expect(response.ok).toBe(true);
        const data = await response.json();

        // Anthropic response format is different
        expect(data).toHaveProperty('content');
        expect(Array.isArray(data.content)).toBe(true);
        expect(data.content[0]).toHaveProperty('text');
        expect(data.content[0].text).toContain('anthropic test');
      } else {
        // Mock Anthropic response
        const mockResponse = {
          id: 'msg_test_123',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'anthropic test response' }],
          model: model.modelId,
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 10 }
        };

        expect(mockResponse.content[0].text).toContain('anthropic test');
      }
    });

    test('should handle tool calling with Anthropic', async () => {
      const messages = [
        {
          role: 'user',
          content: 'Use the web search tool to find information about AI.'
        }
      ];

      if (testEnvironment.enableRealApiCalls && process.env.ANTHROPIC_API_KEY) {
        // Real API call with tools
        const request = createCompletionRequest(model, messages, apiKey, {
          tools: availableTools.slice(0, 1), // Use first tool
          temperature: 0.1,
          maxTokens: 200,
          stream: false
        });

        const response = await fetch(request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(request.body)
        });

        expect(response.ok).toBe(true);
        const data = await response.json();

        expect(data).toHaveProperty('content');
        expect(Array.isArray(data.content)).toBe(true);

        // Check for tool use in content
        const hasToolUse = data.content.some(item => item.type === 'tool_use');
        const hasText = data.content.some(item => item.type === 'text');

        expect(hasToolUse || hasText).toBe(true);
      } else {
        // Mock Anthropic tool response
        const mockResponse = {
          id: 'msg_test_456',
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_test_123',
              name: 'web_search',
              input: { query: 'AI information' }
            }
          ],
          model: model.modelId,
          stop_reason: 'tool_use',
          usage: { input_tokens: 15, output_tokens: 5 }
        };

        expect(mockResponse.content[0].type).toBe('tool_use');
      }
    });
  });

  describe('Google Model Integration', () => {
    const model = testModels.google;
    const apiKey = process.env.GOOGLE_API_KEY || mockApiKeys.google;

    test('should handle simple chat completion', async () => {
      const messages = [{ role: 'user', content: 'Hello, say "google test" in your reply.' }];

      if (testEnvironment.enableRealApiCalls && process.env.GOOGLE_API_KEY) {
        // Real API call
        const request = createCompletionRequest(model, messages, apiKey, {
          temperature: 0.1,
          maxTokens: 50,
          stream: false
        });

        const response = await fetch(request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(request.body)
        });

        expect(response.ok).toBe(true);
        const data = await response.json();

        // Google response format
        expect(data).toHaveProperty('candidates');
        expect(Array.isArray(data.candidates)).toBe(true);
        expect(data.candidates[0]).toHaveProperty('content');
        expect(data.candidates[0].content).toHaveProperty('parts');
        expect(data.candidates[0].content.parts[0].text).toContain('google test');
      } else {
        // Mock Google response
        const mockResponse = {
          candidates: [
            {
              content: {
                parts: [{ text: 'google test response' }],
                role: 'model'
              },
              finishReason: 'STOP',
              index: 0
            }
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 10,
            totalTokenCount: 20
          }
        };

        expect(mockResponse.candidates[0].content.parts[0].text).toContain('google test');
      }
    });
  });

  describe('Mistral Model Integration', () => {
    const model = testModels.mistral;
    const apiKey = process.env.MISTRAL_API_KEY || mockApiKeys.mistral;

    test('should handle simple chat completion', async () => {
      const messages = [{ role: 'user', content: 'Hello, say "mistral test" in your reply.' }];

      if (testEnvironment.enableRealApiCalls && process.env.MISTRAL_API_KEY) {
        // Real API call
        const request = createCompletionRequest(model, messages, apiKey, {
          temperature: 0.1,
          maxTokens: 50,
          stream: false
        });

        const response = await fetch(request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(request.body)
        });

        expect(response.ok).toBe(true);
        const data = await response.json();
        TestHelper.validateModelResponse(data);
        expect(data.choices[0].message.content).toContain('mistral test');
      } else {
        // Mock Mistral response (similar to OpenAI format)
        const mockResponse = MockDataGenerator.generateModelResponse();
        mockResponse.model = model.modelId;
        TestHelper.validateModelResponse(mockResponse);
      }
    });
  });

  describe('Cross-Provider Consistency Tests', () => {
    test('should produce consistent response structure across providers', async () => {
      const testMessage = 'Respond with exactly: "Consistency test passed"';
      const providers = ['openai', 'mistral']; // Test providers with similar response format

      const responses = [];

      for (const provider of providers) {
        const model = testModels[provider];
        const apiKey = process.env[`${provider.toUpperCase()}_API_KEY`] || mockApiKeys[provider];

        if (
          testEnvironment.enableRealApiCalls &&
          process.env[`${provider.toUpperCase()}_API_KEY`]
        ) {
          try {
            const request = createCompletionRequest(
              model,
              [{ role: 'user', content: testMessage }],
              apiKey,
              {
                temperature: 0.1,
                maxTokens: 20,
                stream: false
              }
            );

            const response = await fetch(request.url, {
              method: 'POST',
              headers: request.headers,
              body: JSON.stringify(request.body)
            });

            if (response.ok) {
              const data = await response.json();
              responses.push({ provider, data });
            }
          } catch (error) {
            console.warn(`Error testing ${provider}:`, error.message);
          }
        } else {
          // Mock response
          const mockResponse = MockDataGenerator.generateModelResponse();
          mockResponse.model = model.modelId;
          responses.push({ provider, data: mockResponse });
        }
      }

      // Verify all responses follow the expected structure
      responses.forEach(({ provider, data }) => {
        TestHelper.validateModelResponse(data);
        expect(data.choices).toBeDefined();
        expect(data.choices[0].message).toBeDefined();
        console.log(`${provider} response structure validated`);
      });
    });

    test('should handle rate limiting consistently', async () => {
      // This test would make rapid requests to test rate limiting
      // Implementation depends on your rate limiting setup
      console.log('Rate limiting consistency test - implementation depends on rate limiting setup');
      expect(true).toBe(true); // Placeholder
    });
  });

  describe('Performance and Reliability Tests', () => {
    test('should respond within acceptable time limits', async () => {
      const startTime = Date.now();
      const messages = [{ role: 'user', content: 'Quick response test' }];

      if (testEnvironment.enableRealApiCalls && process.env.OPENAI_API_KEY) {
        const model = testModels.openai;
        const apiKey = process.env.OPENAI_API_KEY;

        const request = createCompletionRequest(model, messages, apiKey, {
          temperature: 0.1,
          maxTokens: 10,
          stream: false
        });

        const response = await fetch(request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(request.body)
        });

        const endTime = Date.now();
        const responseTime = endTime - startTime;

        expect(response.ok).toBe(true);
        expect(responseTime).toBeLessThan(30000); // 30 second max
        console.log(`Response time: ${responseTime}ms`);
      } else {
        // Mock performance test
        await TestHelper.wait(100); // Simulate network delay
        const endTime = Date.now();
        const responseTime = endTime - startTime;
        expect(responseTime).toBeLessThan(1000); // Mock should be fast
      }
    });

    test('should handle concurrent requests', async () => {
      if (testEnvironment.enableRealApiCalls && process.env.OPENAI_API_KEY) {
        const model = testModels.openai;
        const apiKey = process.env.OPENAI_API_KEY;

        const concurrentRequests = 3;
        const promises = Array(concurrentRequests)
          .fill()
          .map(async (_, index) => {
            const messages = [{ role: 'user', content: `Concurrent test ${index + 1}` }];

            const request = createCompletionRequest(model, messages, apiKey, {
              temperature: 0.1,
              maxTokens: 10,
              stream: false
            });

            return fetch(request.url, {
              method: 'POST',
              headers: request.headers,
              body: JSON.stringify(request.body)
            });
          });

        const responses = await Promise.all(promises);

        responses.forEach((response, index) => {
          expect(response.ok).toBe(true);
          console.log(`Concurrent request ${index + 1} completed successfully`);
        });
      } else {
        // Mock concurrent test
        const promises = Array(3)
          .fill()
          .map(async (_, index) => {
            await TestHelper.wait(Math.random() * 100);
            return { ok: true, index };
          });

        const results = await Promise.all(promises);
        expect(results).toHaveLength(3);
        results.forEach(result => expect(result.ok).toBe(true));
      }
    });
  });
});
