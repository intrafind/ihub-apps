import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isValidId } from '../utils/pathSecurity.js';
import logger from '../utils/logger.js';

describe('pathSecurity', () => {
  describe('isValidId', () => {
    it('should accept model IDs with dots (version numbers)', () => {
      assert.strictEqual(isValidId('gemini-2.5-flash'), true);
      assert.strictEqual(isValidId('gemini-2.0-flash'), true);
      assert.strictEqual(isValidId('gpt-4.0-turbo'), true);
      assert.strictEqual(isValidId('model-1.2.3'), true);
    });

    it('should accept IDs with alphanumeric, underscores, hyphens', () => {
      assert.strictEqual(isValidId('valid-model_id'), true);
      assert.strictEqual(isValidId('model123'), true);
      assert.strictEqual(isValidId('my_model-v1'), true);
      assert.strictEqual(isValidId('GPT4'), true);
    });

    it('should reject IDs with double dots (path traversal)', () => {
      assert.strictEqual(isValidId('..'), false);
      assert.strictEqual(isValidId('model..id'), false);
      assert.strictEqual(isValidId('..config'), false);
      assert.strictEqual(isValidId('model/../other'), false);
    });

    it('should reject IDs with slashes (path traversal)', () => {
      assert.strictEqual(isValidId('model/config'), false);
      assert.strictEqual(isValidId('../etc/passwd'), false);
      assert.strictEqual(isValidId('model\\config'), false);
      assert.strictEqual(isValidId('/etc/passwd'), false);
    });

    it('should reject empty IDs', () => {
      assert.strictEqual(isValidId(''), false);
      assert.strictEqual(isValidId(null), false);
      assert.strictEqual(isValidId(undefined), false);
    });

    it('should reject IDs that are too long', () => {
      const longId = 'a'.repeat(101);
      assert.strictEqual(isValidId(longId), false);
    });

    it('should reject IDs with special characters', () => {
      assert.strictEqual(isValidId('model@config'), false);
      assert.strictEqual(isValidId('model#config'), false);
      assert.strictEqual(isValidId('model$config'), false);
      assert.strictEqual(isValidId('model config'), false); // space
      assert.strictEqual(isValidId('model;config'), false);
    });

    it('should accept IDs at exactly 100 characters', () => {
      const maxId = 'a'.repeat(100);
      assert.strictEqual(isValidId(maxId), true);
    });
  });
});
