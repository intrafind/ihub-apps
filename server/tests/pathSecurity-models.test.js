// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Integration test for model API endpoints with dots in IDs
 *
 * This test verifies that model IDs containing dots (like "gemini-2.5-flash")
 * can be properly validated and used in API routes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { assertValidId, assertValidIds } from '../utils/pathSecurity.js';
import logger from '../utils/logger.js';

describe('Model API Path Security Integration', () => {
  describe('assertValidId with model IDs containing dots', () => {
    for (const id of ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-pro']) {
      it(`should validate ${id} model ID`, () => {
        assert.doesNotThrow(() => assertValidId(id, 'model'), `${id} should be valid`);
      });
    }

    it('should reject path traversal attempts with a 400 BAD_REQUEST', () => {
      assert.throws(
        () => assertValidId('../../../etc/passwd', 'model'),
        error =>
          error.status === 400 && error.code === 'BAD_REQUEST' && error.message.includes('Invalid')
      );
    });

    it('should reject double dots', () => {
      assert.throws(
        () => assertValidId('model..config', 'model'),
        error => error.status === 400
      );
    });
  });

  describe('assertValidIds with multiple model IDs', () => {
    it('should validate multiple model IDs with dots', () => {
      const result = assertValidIds('gemini-2.5-flash,gemini-2.0-flash,gpt-4', 'model');

      assert.ok(Array.isArray(result), 'Result should be an array');
      assert.strictEqual(result.length, 3, 'Should have 3 IDs');
      assert.deepStrictEqual(result, ['gemini-2.5-flash', 'gemini-2.0-flash', 'gpt-4']);
    });

    it('should reject if any ID contains path traversal', () => {
      assert.throws(
        () => assertValidIds('gemini-2.5-flash,../evil,gpt-4', 'model'),
        error => error.code === 'BAD_REQUEST' && error.status === 400
      );
    });

    it('should handle wildcard correctly', () => {
      assert.deepStrictEqual(assertValidIds('*', 'model'), ['*'], 'Wildcard should return ["*"]');
    });
  });
});
