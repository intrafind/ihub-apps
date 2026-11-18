// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isValidId, isValidExtensionId, resolveAndValidatePath } from '../utils/pathSecurity.js';

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
      assert.strictEqual(isValidId('.'), false);
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

  describe('isValidExtensionId', () => {
    it('should enforce integration-specific extension ID length bounds', () => {
      assert.strictEqual(isValidExtensionId('short7a'), false);
      assert.strictEqual(isValidExtensionId('valid-id8'), true);
      assert.strictEqual(isValidExtensionId('a'.repeat(128)), true);
      assert.strictEqual(isValidExtensionId('a'.repeat(129)), false);
    });
  });

  describe('resolveAndValidatePath', () => {
    let base;
    let outside;
    before(async () => {
      base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'path-security-')));
      outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'path-security-out-')));
      await fs.mkdir(path.join(base, 'sub'));
    });
    after(async () => {
      await fs.rm(base, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    });

    it('resolves paths inside the base, existing or not', async () => {
      assert.strictEqual(await resolveAndValidatePath('a.json', base), path.join(base, 'a.json'));
      assert.strictEqual(
        await resolveAndValidatePath('sub/new/b.json', base),
        path.join(base, 'sub', 'new', 'b.json')
      );
      assert.strictEqual(
        await resolveAndValidatePath('sub/../c.json', base),
        path.join(base, 'c.json')
      );
      // A name that only starts with two dots stays inside.
      assert.strictEqual(await resolveAndValidatePath('..notes', base), path.join(base, '..notes'));
    });

    it('accepts the base itself', async () => {
      assert.strictEqual(await resolveAndValidatePath('.', base), base);
    });

    it('refuses paths that leave the base', async () => {
      assert.strictEqual(await resolveAndValidatePath('../x.json', base), null);
      assert.strictEqual(await resolveAndValidatePath('sub/../../x.json', base), null);
      assert.strictEqual(await resolveAndValidatePath(path.join(outside, 'x.json'), base), null);
      // A sibling whose name starts with the base's name is outside too.
      assert.strictEqual(await resolveAndValidatePath(`${base}-evil/x.json`, base), null);
    });

    it('refuses a symlink inside the base that points outside it', async () => {
      await fs.symlink(outside, path.join(base, 'link'));
      assert.strictEqual(await resolveAndValidatePath('link/x.json', base), null);
    });

    it('refuses empty and non-string input', async () => {
      assert.strictEqual(await resolveAndValidatePath('', base), null);
      assert.strictEqual(await resolveAndValidatePath(undefined, base), null);
    });
  });
});
