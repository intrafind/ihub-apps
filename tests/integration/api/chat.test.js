import request from 'supertest';
import { TestHelper, TestValidators } from '../utils/helpers.js';
import { testUsers, testApps, testModels } from '../utils/fixtures.js';

/**
 * Integration Tests for Chat API
 * These tests validate the chat API endpoints with real HTTP requests
 */

describe('Chat API Integration Tests', () => {
  let app;
  let server;

  beforeAll(async () => {
    // Set up test environment
    await TestHelper.setupTestEnvironment();
    
    // Import and start the server (adjust import path as needed)
    const { default: serverApp } = await import('../../server/server.js');
    app = serverApp;
  });

  afterAll(async () => {
    // Clean up test environment
    await TestHelper.cleanupTestData();
    if (server) {
      server.close();
    }
  });

  describe('POST /api/chat/sessions', () => {
    test('should create a new chat session with valid data', async () => {
      const headers = TestHelper.createAuthHeaders(testUsers.regularUser);
      
      const response = await request(app)
        .post('/api/chat/sessions')
        .set(headers)
        .send({
          appId: testApps.generalChat.id,
          modelId: testModels.openai.modelId,
        })
        .expect(201);

      TestValidators.validateChatSession(response.body);
      expect(response.body.appId).toBe(testApps.generalChat.id);
      expect(response.body.model).toBe(testModels.openai.modelId);
    });

    test('should reject session creation without authentication', async () => {
      const response = await request(app)
        .post('/api/chat/sessions')
        .send({
          appId: testApps.generalChat.id,
          modelId: testModels.openai.modelId,
        })
        .expect(401);

      TestValidators.validateErrorResponse(response, 401);
    });

    test('should reject session creation with invalid app ID', async () => {
      const headers = TestHelper.createAuthHeaders(testUsers.regularUser);
      
      const response = await request(app)
        .post('/api/chat/sessions')
        .set(headers)
        .send({
          appId: 'invalid-app-id',
          modelId: testModels.openai.modelId,
        })
        .expect(404);

      TestValidators.validateErrorResponse(response, 404);
    });

    test('should enforce group permissions for app access', async () => {
      const headers = TestHelper.createAuthHeaders(testUsers.regularUser);
      
      const response = await request(app)
        .post('/api/chat/sessions')
        .set(headers)
        .send({
          appId: testApps.financeApp.id, // Finance app, but user is not in finance group
          modelId: testModels.openai.modelId,
        })
        .expect(403);

      TestValidators.validateErrorResponse(response, 403);
    });
  });

  describe('POST /api/chat/sessions/:sessionId/messages', () => {
    let sessionId;

    beforeEach(async () => {
      // Create a test session
      const headers = TestHelper.createAuthHeaders(testUsers.regularUser);
      const sessionResponse = await request(app)
        .post('/api/chat/sessions')
        .set(headers)
        .send({
          appId: testApps.generalChat.id,
          modelId: testModels.openai.modelId,
        });
      
      sessionId = sessionResponse.body.id;
    });

    test('should send a message and receive a response', async () => {
      const headers = TestHelper.createAuthHeaders(testUsers.regularUser);
      
      const response = await request(app)
        .post(`/api/chat/sessions/${sessionId}/messages`)
        .set(headers)
        .send({
          message: 'Hello, how are you?',
        })
        .expect(200);

      expect(response.body).toHaveProperty('response');
      expect(response.body.response).toHaveProperty('content');
      expect(typeof response.body.response.content).toBe('string');
      expect(response.body.response.content.length).toBeGreaterThan(0);
    });

    test('should handle tool calling requests', async () => {
      // Create session with tool-enabled app
      const headers = TestHelper.createAuthHeaders(testUsers.financeUser);
      const toolSessionResponse = await request(app)
        .post('/api/chat/sessions')
        .set(headers)
        .send({
          appId: testApps.financeApp.id,
          modelId: testModels.openai.modelId,
        });
      
      const toolSessionId = toolSessionResponse.body.id;

      const response = await request(app)
        .post(`/api/chat/sessions/${toolSessionId}/messages`)
        .set(headers)
        .send({
          message: 'Search for financial data about Apple Inc.',
        })
        .expect(200);

      expect(response.body).toHaveProperty('response');
      
      // Check if tool calls were made
      if (response.body.toolCalls) {
        expect(Array.isArray(response.body.toolCalls)).toBe(true);
        response.body.toolCalls.forEach(toolCall => {
          expect(toolCall).toHaveProperty('function');
          expect(toolCall.function).toHaveProperty('name');
        });
      }
    });

    test('should reject messages to non-existent sessions', async () => {
      const headers = TestHelper.createAuthHeaders(testUsers.regularUser);
      
      const response = await request(app)
        .post('/api/chat/sessions/non-existent-session/messages')
        .set(headers)
        .send({
          message: 'Hello',
        })
        .expect(404);

      TestValidators.validateErrorResponse(response, 404);
    });

    test('should reject empty messages', async () => {
      const headers = TestHelper.createAuthHeaders(testUsers.regularUser);
      
      const response = await request(app)
        .post(`/api/chat/sessions/${sessionId}/messages`)
        .set(headers)
        .send({
          message: '',
        })
        .expect(400);

      TestValidators.validateErrorResponse(response, 400);
    });

    test('should handle rate limiting', async () => {
      const headers = TestHelper.createAuthHeaders(testUsers.regularUser);
      
      // Send multiple rapid requests
      const requests = Array(10).fill().map(() =>
        request(app)
          .post(`/api/chat/sessions/${sessionId}/messages`)
          .set(headers)
          .send({
            message: `Rate limit test message ${Date.now()}`,
          })
      );

      const responses = await Promise.allSettled(requests);
      
      // Check if some requests were rate limited
      const rateLimitedResponses = responses.filter(
        result => result.status === 'fulfilled' && result.value.status === 429
      );
      
      // Expect at least some rate limiting to occur
      expect(rateLimitedResponses.length).toBeGreaterThan(0);
    });
  });

  describe('GET /api/chat/sessions/:sessionId', () => {
    let sessionId;

    beforeEach(async () => {
      const headers = TestHelper.createAuthHeaders(testUsers.regularUser);
      const sessionResponse = await request(app)
        .post('/api/chat/sessions')
        .set(headers)
        .send({
          appId: testApps.generalChat.id,
          modelId: testModels.openai.modelId,
        });
      
      sessionId = sessionResponse.body.id;
    });

    test('should retrieve session details', async () => {
      const headers = TestHelper.createAuthHeaders(testUsers.regularUser);
      
      const response = await request(app)
        .get(`/api/chat/sessions/${sessionId}`)
        .set(headers)
        .expect(200);

      TestValidators.validateChatSession(response.body);
      expect(response.body.id).toBe(sessionId);
    });

    test('should not allow access to other users sessions', async () => {
      const otherUserHeaders = TestHelper.createAuthHeaders(testUsers.financeUser);
      
      const response = await request(app)
        .get(`/api/chat/sessions/${sessionId}`)
        .set(otherUserHeaders)
        .expect(403);

      TestValidators.validateErrorResponse(response, 403);
    });
  });

  describe('GET /api/chat/sessions', () => {
    test('should list user sessions', async () => {
      const headers = TestHelper.createAuthHeaders(testUsers.regularUser);
      
      // Create a test session first
      await request(app)
        .post('/api/chat/sessions')
        .set(headers)
        .send({
          appId: testApps.generalChat.id,
          modelId: testModels.openai.modelId,
        });

      const response = await request(app)
        .get('/api/chat/sessions')
        .set(headers)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
      
      response.body.forEach(session => {
        TestValidators.validateChatSession(session);
      });
    });

    test('should only return user-owned sessions', async () => {
      const user1Headers = TestHelper.createAuthHeaders(testUsers.regularUser);
      const user2Headers = TestHelper.createAuthHeaders(testUsers.financeUser);
      
      // Create session for user 1
      await request(app)
        .post('/api/chat/sessions')
        .set(user1Headers)
        .send({
          appId: testApps.generalChat.id,
          modelId: testModels.openai.modelId,
        });

      // Create session for user 2
      await request(app)
        .post('/api/chat/sessions')
        .set(user2Headers)
        .send({
          appId: testApps.generalChat.id,
          modelId: testModels.openai.modelId,
        });

      // User 1 should only see their own sessions
      const user1Response = await request(app)
        .get('/api/chat/sessions')
        .set(user1Headers)
        .expect(200);

      user1Response.body.forEach(session => {
        expect(session.userId).toBe(testUsers.regularUser.id);
      });

      // User 2 should only see their own sessions
      const user2Response = await request(app)
        .get('/api/chat/sessions')
        .set(user2Headers)
        .expect(200);

      user2Response.body.forEach(session => {
        expect(session.userId).toBe(testUsers.financeUser.id);
      });
    });
  });

  describe('DELETE /api/chat/sessions/:sessionId', () => {
    let sessionId;

    beforeEach(async () => {
      const headers = TestHelper.createAuthHeaders(testUsers.regularUser);
      const sessionResponse = await request(app)
        .post('/api/chat/sessions')
        .set(headers)
        .send({
          appId: testApps.generalChat.id,
          modelId: testModels.openai.modelId,
        });
      
      sessionId = sessionResponse.body.id;
    });

    test('should delete a session', async () => {
      const headers = TestHelper.createAuthHeaders(testUsers.regularUser);
      
      await request(app)
        .delete(`/api/chat/sessions/${sessionId}`)
        .set(headers)
        .expect(204);

      // Verify session is deleted
      await request(app)
        .get(`/api/chat/sessions/${sessionId}`)
        .set(headers)
        .expect(404);
    });

    test('should not allow deletion of other users sessions', async () => {
      const otherUserHeaders = TestHelper.createAuthHeaders(testUsers.financeUser);
      
      const response = await request(app)
        .delete(`/api/chat/sessions/${sessionId}`)
        .set(otherUserHeaders)
        .expect(403);

      TestValidators.validateErrorResponse(response, 403);
    });
  });
});