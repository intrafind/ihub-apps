/**
 * Integration test for model API endpoints with dots in IDs
 * 
 * This test verifies that model IDs containing dots (like "gemini-2.5-flash")
 * can be properly validated and used in API routes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateIdForPath, validateIdsForPath } from '../utils/pathSecurity.js';

describe('Model API Path Security Integration', () => {
  describe('validateIdForPath with model IDs containing dots', () => {
    it('should validate gemini-2.5-flash model ID', () => {
      const mockRes = {
        status: () => mockRes,
        json: () => {}
      };
      const result = validateIdForPath('gemini-2.5-flash', 'model', mockRes);
      assert.strictEqual(result, true, 'gemini-2.5-flash should be valid');
    });

    it('should validate gemini-2.0-flash model ID', () => {
      const mockRes = {
        status: () => mockRes,
        json: () => {}
      };
      const result = validateIdForPath('gemini-2.0-flash', 'model', mockRes);
      assert.strictEqual(result, true, 'gemini-2.0-flash should be valid');
    });

    it('should validate gemini-2.5-pro model ID', () => {
      const mockRes = {
        status: () => mockRes,
        json: () => {}
      };
      const result = validateIdForPath('gemini-2.5-pro', 'model', mockRes);
      assert.strictEqual(result, true, 'gemini-2.5-pro should be valid');
    });

    it('should reject path traversal attempts', () => {
      let statusCalled = false;
      let errorMessage = '';
      const mockRes = {
        status: (code) => {
          statusCalled = true;
          assert.strictEqual(code, 400);
          return mockRes;
        },
        json: (data) => {
          errorMessage = data.error;
        }
      };
      
      const result = validateIdForPath('../../../etc/passwd', 'model', mockRes);
      assert.strictEqual(result, false, 'Path traversal should be rejected');
      assert.strictEqual(statusCalled, true, 'Status should be set to 400');
      assert.ok(errorMessage.includes('Invalid'), 'Error message should indicate invalid ID');
    });

    it('should reject double dots', () => {
      let statusCalled = false;
      const mockRes = {
        status: (code) => {
          statusCalled = true;
          return mockRes;
        },
        json: () => {}
      };
      
      const result = validateIdForPath('model..config', 'model', mockRes);
      assert.strictEqual(result, false, 'Double dots should be rejected');
      assert.strictEqual(statusCalled, true, 'Status should be set to 400');
    });
  });

  describe('validateIdsForPath with multiple model IDs', () => {
    it('should validate multiple model IDs with dots', () => {
      const mockRes = {
        status: () => mockRes,
        json: () => {}
      };
      
      const ids = 'gemini-2.5-flash,gemini-2.0-flash,gpt-4';
      const result = validateIdsForPath(ids, 'model', mockRes);
      
      assert.ok(Array.isArray(result), 'Result should be an array');
      assert.strictEqual(result.length, 3, 'Should have 3 IDs');
      assert.deepStrictEqual(result, ['gemini-2.5-flash', 'gemini-2.0-flash', 'gpt-4']);
    });

    it('should reject if any ID contains path traversal', () => {
      let statusCalled = false;
      const mockRes = {
        status: (code) => {
          statusCalled = true;
          return mockRes;
        },
        json: () => {}
      };
      
      const ids = 'gemini-2.5-flash,../evil,gpt-4';
      const result = validateIdsForPath(ids, 'model', mockRes);
      
      assert.strictEqual(result, false, 'Should reject if any ID is invalid');
      assert.strictEqual(statusCalled, true, 'Status should be set to 400');
    });

    it('should handle wildcard correctly', () => {
      const mockRes = {
        status: () => mockRes,
        json: () => {}
      };
      
      const result = validateIdsForPath('*', 'model', mockRes);
      assert.deepStrictEqual(result, ['*'], 'Wildcard should return ["*"]');
    });
  });
});
