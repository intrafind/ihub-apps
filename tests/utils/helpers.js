import jwt from 'jsonwebtoken';
import { testUsers, testEnvironment, mockApiKeys } from './fixtures.js';

/**
 * Test helper utilities for consistent testing across all test suites
 */

export class TestHelper {
  /**
   * Generate a JWT token for testing authentication
   */
  static generateTestToken(user = testUsers.regularUser, expiresIn = '1h') {
    const secret = process.env.JWT_SECRET || 'test-secret-key';
    return jwt.sign(
      {
        id: user.id,
        username: user.username,
        email: user.email,
        groups: user.groups,
        role: user.role,
      },
      secret,
      { expiresIn }
    );
  }

  /**
   * Generate an expired JWT token for testing
   */
  static generateExpiredToken(user = testUsers.regularUser) {
    return this.generateTestToken(user, '-1h');
  }

  /**
   * Create test request headers with authentication
   */
  static createAuthHeaders(user = testUsers.regularUser) {
    return {
      'Authorization': `Bearer ${this.generateTestToken(user)}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Wait for a specified amount of time
   */
  static wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Retry a function until it succeeds or max attempts are reached
   */
  static async retry(fn, maxAttempts = 3, delay = 1000) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (attempt === maxAttempts) {
          throw error;
        }
        await this.wait(delay);
      }
    }
  }

  /**
   * Generate a random string for unique test data
   */
  static randomString(length = 8) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  /**
   * Generate unique test identifiers
   */
  static generateTestId(prefix = 'test') {
    return `${prefix}-${Date.now()}-${this.randomString(4)}`;
  }

  /**
   * Clean up test data (implement based on your data storage)
   */
  static async cleanupTestData() {
    // Implement cleanup logic for test data
    // This could include clearing test databases, files, etc.
    console.log('Cleaning up test data...');
  }

  /**
   * Setup test environment
   */
  static async setupTestEnvironment() {
    // Set up any required test environment state
    console.log('Setting up test environment...');
  }

  /**
   * Validate API response structure
   */
  static validateApiResponse(response, expectedFields = []) {
    expect(response).toBeDefined();
    expect(response.status).toBeDefined();
    
    if (response.status >= 200 && response.status < 300) {
      expect(response.body).toBeDefined();
      
      expectedFields.forEach(field => {
        expect(response.body).toHaveProperty(field);
      });
    }
    
    return response;
  }

  /**
   * Mock external API responses
   */
  static mockExternalApi(provider, response) {
    // Mock implementation would depend on your mocking library
    // This is a placeholder for the concept
    console.log(`Mocking ${provider} API with response:`, response);
  }

  /**
   * Validate model response structure
   */
  static validateModelResponse(response) {
    expect(response).toBeDefined();
    expect(response).toHaveProperty('choices');
    expect(Array.isArray(response.choices)).toBe(true);
    expect(response.choices.length).toBeGreaterThan(0);
    
    const choice = response.choices[0];
    expect(choice).toHaveProperty('message');
    expect(choice.message).toHaveProperty('role');
    
    if (choice.message.content) {
      expect(typeof choice.message.content).toBe('string');
    }
    
    if (choice.message.tool_calls) {
      expect(Array.isArray(choice.message.tool_calls)).toBe(true);
      choice.message.tool_calls.forEach(toolCall => {
        expect(toolCall).toHaveProperty('function');
        expect(toolCall.function).toHaveProperty('name');
        expect(toolCall.function).toHaveProperty('arguments');
      });
    }
    
    return response;
  }

  /**
   * Create a test server instance
   */
  static async createTestServer() {
    // This would create a test instance of your server
    // Implementation depends on your server setup
    console.log('Creating test server instance...');
  }

  /**
   * Get environment-specific configuration
   */
  static getTestConfig() {
    return {
      ...testEnvironment,
      apiKeys: mockApiKeys,
      isRealApiCall: testEnvironment.enableRealApiCalls,
    };
  }

  /**
   * Create test chat session
   */
  static async createTestChatSession(app, user = testUsers.regularUser) {
    return {
      id: this.generateTestId('session'),
      appId: app.id,
      userId: user.id,
      model: app.model,
      systemPrompt: app.systemPrompt,
      messages: [],
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Simulate user interaction delay
   */
  static async simulateUserDelay(min = 500, max = 2000) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    await this.wait(delay);
  }

  /**
   * Format test results for reporting
   */
  static formatTestResults(results) {
    return {
      passed: results.filter(r => r.status === 'passed').length,
      failed: results.filter(r => r.status === 'failed').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      total: results.length,
      duration: results.reduce((sum, r) => sum + (r.duration || 0), 0),
    };
  }
}

/**
 * Mock data generators for testing
 */
export class MockDataGenerator {
  /**
   * Generate mock chat messages
   */
  static generateChatMessages(count = 5) {
    const messages = [];
    for (let i = 0; i < count; i++) {
      messages.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Test message ${i + 1}`,
        timestamp: new Date(Date.now() - (count - i) * 60000).toISOString(),
      });
    }
    return messages;
  }

  /**
   * Generate mock model response
   */
  static generateModelResponse(includeToolCalls = false) {
    const response = {
      id: `chatcmpl-${TestHelper.randomString(12)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'gpt-4',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: includeToolCalls ? null : 'This is a mock response.',
          },
          finish_reason: includeToolCalls ? 'tool_calls' : 'stop',
        },
      ],
      usage: {
        prompt_tokens: Math.floor(Math.random() * 100) + 10,
        completion_tokens: Math.floor(Math.random() * 100) + 10,
        total_tokens: 0,
      },
    };

    response.usage.total_tokens = response.usage.prompt_tokens + response.usage.completion_tokens;

    if (includeToolCalls) {
      response.choices[0].message.tool_calls = [
        {
          id: `call_${TestHelper.randomString(12)}`,
          type: 'function',
          function: {
            name: 'web_search',
            arguments: '{"query": "test query"}',
          },
        },
      ];
    }

    return response;
  }

  /**
   * Generate mock error response
   */
  static generateErrorResponse(statusCode = 400, message = 'Test error') {
    return {
      error: {
        message,
        type: 'test_error',
        code: statusCode,
      },
    };
  }
}

/**
 * Test assertions and validators
 */
export class TestValidators {
  /**
   * Validate chat session structure
   */
  static validateChatSession(session) {
    expect(session).toHaveProperty('id');
    expect(session).toHaveProperty('appId');
    expect(session).toHaveProperty('userId');
    expect(session).toHaveProperty('model');
    expect(session).toHaveProperty('messages');
    expect(Array.isArray(session.messages)).toBe(true);
  }

  /**
   * Validate user structure
   */
  static validateUser(user) {
    expect(user).toHaveProperty('id');
    expect(user).toHaveProperty('username');
    expect(user).toHaveProperty('groups');
    expect(Array.isArray(user.groups)).toBe(true);
  }

  /**
   * Validate app structure
   */
  static validateApp(app) {
    expect(app).toHaveProperty('id');
    expect(app).toHaveProperty('name');
    expect(app).toHaveProperty('model');
    expect(app).toHaveProperty('groups');
    expect(Array.isArray(app.groups)).toBe(true);
  }

  /**
   * Validate API error response
   */
  static validateErrorResponse(response, expectedStatus) {
    expect(response.status).toBe(expectedStatus);
    expect(response.body).toHaveProperty('error');
    if (response.body.message) {
      expect(typeof response.body.message).toBe('string');
    }
  }
}