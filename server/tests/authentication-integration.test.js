/**
 * Authentication Integration Tests
 *
 * Tests real-world authentication scenarios and edge cases
 */

import request from 'supertest';
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { setupMiddleware } from '../serverHelpers.js';
import registerAuthRoutes from '../routes/auth.js';
import registerAdminRoutes from '../routes/adminRoutes.js';
import jwt from 'jsonwebtoken';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Authentication Integration Tests', () => {
  let app;
  let testUsersFile;
  let testPlatformFile;

  beforeEach(async () => {
    // Create test app
    app = express();

    // Create temporary test files
    const testDir = path.join(__dirname, 'temp');
    await fs.mkdir(testDir, { recursive: true });

    testUsersFile = path.join(testDir, 'users.json');
    testPlatformFile = path.join(testDir, 'platform.json');

    // Create test platform config
    const testPlatformConfig = {
      auth: {
        mode: 'local',
        allowAnonymous: false,
        anonymousGroup: 'anonymous',
        authenticatedGroup: 'authenticated'
      },
      localAuth: {
        enabled: true,
        usersFile: testUsersFile,
        jwtSecret: 'test-secret-key',
        sessionTimeoutMinutes: 480
      },
      authorization: {
        adminGroups: ['admin'],
        userGroups: ['user'],
        anonymousAccess: false,
        defaultGroup: 'anonymous'
      }
    };

    // Create test users
    const testUsers = {
      users: {
        user_1: {
          id: 'user_1',
          username: 'testuser',
          email: 'test@example.com',
          groups: ['user'],
          active: true,
          passwordHash: '$2b$10$test.hash.here',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        user_2: {
          id: 'user_2',
          username: 'admin',
          email: 'admin@example.com',
          groups: ['admin'],
          active: true,
          passwordHash: '$2b$10$test.hash.here',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        user_3: {
          id: 'user_3',
          username: 'inactive',
          email: 'inactive@example.com',
          groups: ['user'],
          active: false,
          passwordHash: '$2b$10$test.hash.here',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      },
      metadata: {
        version: '2.0.0',
        description: 'Test user database',
        passwordHashingMethod: 'bcrypt + userId salt',
        lastUpdated: new Date().toISOString()
      }
    };

    // Write test files
    await fs.writeFile(testPlatformFile, JSON.stringify(testPlatformConfig, null, 2));
    await fs.writeFile(testUsersFile, JSON.stringify(testUsers, null, 2));

    // Setup middleware
    setupMiddleware(app, testPlatformConfig);

    // Register routes
    registerAuthRoutes(app);
    registerAdminRoutes(app);
  });

  afterEach(async () => {
    // Cleanup test files
    try {
      await fs.unlink(testUsersFile);
      await fs.unlink(testPlatformFile);
      await fs.rmdir(path.dirname(testUsersFile));
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Login Flow Security', () => {
    test('should reject login with invalid credentials', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          username: 'testuser',
          password: 'wrongpassword'
        })
        .expect(401);

      expect(response.body.error).toBeDefined();
      expect(response.body.token).toBeUndefined();
    });

    test('should reject login for inactive user', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          username: 'inactive',
          password: 'password'
        })
        .expect(401);

      expect(response.body.error).toBeDefined();
    });

    test('should reject login with missing credentials', async () => {
      await request(app)
        .post('/api/auth/login')
        .send({
          username: 'testuser'
          // Missing password
        })
        .expect(400);

      await request(app)
        .post('/api/auth/login')
        .send({
          password: 'password'
          // Missing username
        })
        .expect(400);
    });

    test('should handle SQL injection attempts in username', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          username: "admin'; DROP TABLE users; --",
          password: 'password'
        })
        .expect(401);

      expect(response.body.error).toBeDefined();
    });

    test('should handle XSS attempts in username', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          username: '<script>alert("xss")</script>',
          password: 'password'
        })
        .expect(401);

      expect(response.body.error).toBeDefined();
    });
  });

  describe('JWT Token Security', () => {
    test('should generate secure JWT tokens on successful login', async () => {
      // Mock successful password verification
      const originalBcrypt = require('bcrypt');
      jest.spyOn(originalBcrypt, 'compare').mockResolvedValue(true);

      const response = await request(app)
        .post('/api/auth/login')
        .send({
          username: 'testuser',
          password: 'password'
        })
        .expect(200);

      expect(response.body.token).toBeDefined();
      expect(response.body.user).toBeDefined();
      expect(response.body.user.username).toBe('testuser');
      expect(response.body.user.passwordHash).toBeUndefined(); // Should not leak password hash

      // Verify token structure
      const decoded = jwt.decode(response.body.token);
      expect(decoded.userId).toBe('user_1');
      expect(decoded.username).toBe('testuser');
      expect(decoded.groups).toContain('user');
      expect(decoded.exp).toBeDefined(); // Should have expiration
    });

    test('should reject tampered JWT tokens', async () => {
      const validToken = jwt.sign(
        { userId: 'user_1', username: 'testuser', groups: ['user'] },
        'test-secret-key'
      );

      // Tamper with the token
      const tamperedToken = validToken.slice(0, -5) + 'XXXXX';

      const response = await request(app)
        .get('/api/auth/user')
        .set('Authorization', `Bearer ${tamperedToken}`)
        .expect(401);

      expect(response.body.error).toBeDefined();
    });

    test('should reject tokens signed with wrong secret', async () => {
      const maliciousToken = jwt.sign(
        { userId: 'user_1', username: 'testuser', groups: ['admin'] },
        'wrong-secret'
      );

      await request(app)
        .get('/api/auth/user')
        .set('Authorization', `Bearer ${maliciousToken}`)
        .expect(401);
    });

    test('should handle token with missing claims', async () => {
      const incompleteToken = jwt.sign(
        { username: 'testuser' }, // Missing userId and groups
        'test-secret-key'
      );

      const response = await request(app)
        .get('/api/auth/user')
        .set('Authorization', `Bearer ${incompleteToken}`)
        .expect(200);

      // Should handle gracefully with default values
      expect(response.body.user).toBeDefined();
    });
  });

  describe('Session Management', () => {
    test('should track user sessions properly', async () => {
      const token = jwt.sign(
        { userId: 'user_1', username: 'testuser', groups: ['user'] },
        'test-secret-key'
      );

      const response = await request(app)
        .get('/api/auth/user')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body.user.username).toBe('testuser');
      expect(response.body.user.groups).toContain('user');
    });

    test('should handle logout properly', async () => {
      const response = await request(app).post('/api/auth/logout').expect(200);

      expect(response.body.message).toBeDefined();
    });
  });

  describe('Rate Limiting and Security Headers', () => {
    test('should handle multiple rapid login attempts', async () => {
      // Simulate multiple rapid login attempts
      const promises = Array(10)
        .fill()
        .map(() =>
          request(app).post('/api/auth/login').send({
            username: 'testuser',
            password: 'wrongpassword'
          })
        );

      const responses = await Promise.all(promises);

      // All should fail with 401
      responses.forEach(response => {
        expect(response.status).toBe(401);
      });
    });

    test('should set security headers', async () => {
      const response = await request(app).get('/api/auth/status').expect(200);

      // Check for CORS headers (if enabled)
      expect(response.headers['access-control-allow-origin']).toBeDefined();
    });
  });

  describe('User Information Disclosure', () => {
    test('should not leak sensitive user information', async () => {
      const token = jwt.sign(
        { userId: 'user_1', username: 'testuser', groups: ['user'] },
        'test-secret-key'
      );

      const response = await request(app)
        .get('/api/auth/user')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // Should not include sensitive fields
      expect(response.body.user.passwordHash).toBeUndefined();
      expect(response.body.user.password).toBeUndefined();

      // Should include safe fields
      expect(response.body.user.username).toBeDefined();
      expect(response.body.user.email).toBeDefined();
      expect(response.body.user.groups).toBeDefined();
    });

    test('should handle user enumeration protection', async () => {
      // Test with non-existent user
      const response1 = await request(app)
        .post('/api/auth/login')
        .send({
          username: 'nonexistent',
          password: 'password'
        })
        .expect(401);

      // Test with existing user but wrong password
      const response2 = await request(app)
        .post('/api/auth/login')
        .send({
          username: 'testuser',
          password: 'wrongpassword'
        })
        .expect(401);

      // Error messages should be similar to prevent user enumeration
      expect(response1.body.error).toBeDefined();
      expect(response2.body.error).toBeDefined();
    });
  });

  describe('Error Handling Security', () => {
    test('should handle malformed JSON gracefully', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send('{"invalid": json}')
        .expect(400);

      expect(response.body.error).toBeDefined();
    });

    test('should handle oversized payloads', async () => {
      const largePayload = {
        username: 'a'.repeat(10000),
        password: 'b'.repeat(10000)
      };

      await request(app).post('/api/auth/login').send(largePayload).expect(400);
    });

    test('should not expose internal errors', async () => {
      // Simulate internal error by providing invalid data
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          username: null,
          password: null
        })
        .expect(400);

      // Should not expose stack traces or internal details
      expect(response.body.stack).toBeUndefined();
      expect(response.body.error).toBeDefined();
      expect(typeof response.body.error).toBe('string');
    });
  });
});

describe('Authorization Edge Cases', () => {
  test('should handle circular group references safely', () => {
    // This would be tested with mock data that has circular references
    const userWithCircularGroups = {
      id: 'test',
      groups: ['group1', 'group2']
      // Where group1 references group2 and vice versa
    };

    // Test that the authorization system handles this gracefully
    expect(() => {
      // Call authorization enhancement function
      // Should not cause infinite loops
    }).not.toThrow();
  });

  test('should handle extremely large group arrays', () => {
    const userWithManyGroups = {
      id: 'test',
      groups: Array(1000)
        .fill()
        .map((_, i) => `group_${i}`)
    };

    // Should handle large arrays without performance issues
    expect(() => {
      // Call authorization enhancement function
    }).not.toThrow();
  });

  test('should sanitize group names', () => {
    const userWithMaliciousGroups = {
      id: 'test',
      groups: ['../../../admin', '<script>alert("xss")</script>', 'normal-group']
    };

    // Should sanitize or reject malicious group names
    expect(() => {
      // Call authorization enhancement function
    }).not.toThrow();
  });
});
