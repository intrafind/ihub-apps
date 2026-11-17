// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `E2E_FRESH_CONTENTS=1` must never delete a real contents directory (review
 * finding R10): only `contents-e2e*` inside the repository.
 */

import { describe, test, expect, afterEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  disposableContentsPath,
  e2eContentsDir,
  removeDisposableContents
} from '../../tests/config/e2e-fresh-contents.mjs';

const roots = [];
const tempRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-e2e-fresh-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('disposableContentsPath', () => {
  test.each(['contents-e2e', 'contents-e2e-safety', './contents-e2e-x'])('%s is allowed', dir => {
    expect(disposableContentsPath('/repo', dir)).toBe(path.resolve('/repo', dir));
  });

  test.each(['contents', '.', '', '../contents-e2e', '/tmp/contents-e2e', 'contents/sub'])(
    '%s is refused',
    dir => {
      expect(() => disposableContentsPath('/repo', dir)).toThrow(/refusing to delete/);
    }
  );
});

describe('removeDisposableContents', () => {
  test('deletes an e2e directory and leaves a real contents directory alone', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'contents-e2e', 'config'), { recursive: true });
    fs.mkdirSync(path.join(root, 'contents'), { recursive: true });
    fs.writeFileSync(path.join(root, 'contents', '.encryption-key'), 'k');

    removeDisposableContents(root, 'contents-e2e');
    expect(() => removeDisposableContents(root, 'contents')).toThrow();

    expect(fs.existsSync(path.join(root, 'contents-e2e'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'contents', '.encryption-key'))).toBe(true);
  });
});

describe('a symlinked parent', () => {
  test('pointing out of the repository is refused before anything is deleted', () => {
    const root = tempRoot();
    const outside = tempRoot();
    fs.mkdirSync(path.join(outside, 'contents-e2e'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'contents-e2e', 'keep'), 'k');
    fs.symlinkSync(outside, path.join(root, 'linked'), 'dir');

    expect(() => removeDisposableContents(root, 'linked/contents-e2e')).toThrow(
      /refusing to delete/
    );
    expect(fs.existsSync(path.join(outside, 'contents-e2e', 'keep'))).toBe(true);
  });

  test('a directory that does not exist yet is still fine', () => {
    const root = tempRoot();
    expect(disposableContentsPath(root, 'contents-e2e-new')).toBe(
      path.join(root, 'contents-e2e-new')
    );
  });
});

describe('e2eContentsDir (checked whether or not E2E_FRESH_CONTENTS is set)', () => {
  test('defaults to contents-e2e and accepts contents-e2e-safety', () => {
    expect(e2eContentsDir('/repo', {})).toBe('contents-e2e');
    expect(e2eContentsDir('/repo', { E2E_CONTENTS_DIR: 'contents-e2e-safety' })).toBe(
      'contents-e2e-safety'
    );
  });

  test('E2E_CONTENTS_DIR=contents without E2E_FRESH_CONTENTS is refused', () => {
    expect(() => e2eContentsDir('/repo', { E2E_CONTENTS_DIR: 'contents' })).toThrow(
      /refusing to delete or rewrite "contents"/
    );
  });
});
