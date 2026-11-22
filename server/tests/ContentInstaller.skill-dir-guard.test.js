// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The directory of a marketplace skill is a direct child of the skills
 * directory: `_writeContent` and `_deleteContent` re-check the item name at the
 * filesystem call (the install and uninstall entry points validate it too), and
 * a write never goes through a symlink that leads out of the skills directory.
 *
 * Run with `NODE_OPTIONS=--experimental-vm-modules` (native ESM, see
 * ContentInstaller.skill-path-traversal.test.js).
 */

import { jest } from '@jest/globals';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';

// A `.env` or runner value for CONTENTS_DIR could be absolute, which would move every write
// of the installer out of the fixture root: keep it relative.
process.env.CONTENTS_DIR = 'contents';

const state = { rootDir: os.tmpdir() };

jest.unstable_mockModule('../pathUtils.js', () => ({
  getRootDir: () => state.rootDir
}));

const { default: contentInstaller } = await import('../services/marketplace/ContentInstaller.js');

const TYPE = { dir: 'skills', ext: null };

describe('ContentInstaller skill directory guard', () => {
  let tmpRoot;
  let skillsDir;
  let outside;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-skill-dir-guard-'));
    state.rootDir = tmpRoot;
    skillsDir = path.join(tmpRoot, 'contents', 'skills');
    outside = path.join(tmpRoot, 'outside');
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  test('writes a bare SKILL.md into the skill directory', async () => {
    await contentInstaller._writeContent('skill', 'my-skill', '# Skill', TYPE);
    expect(await fs.readFile(path.join(skillsDir, 'my-skill', 'SKILL.md'), 'utf8')).toBe('# Skill');
  });

  test('creates the skills directory when it does not exist yet', async () => {
    await fs.rm(skillsDir, { recursive: true, force: true });
    await contentInstaller._writeContent('skill', 'fresh', '# Fresh', TYPE);
    expect(existsSync(path.join(skillsDir, 'fresh', 'SKILL.md'))).toBe(true);
  });

  test.each(['..', '.', '../outside', 'a/b', 'a\\b', '', 'name\0x', '/etc'])(
    'rejects the skill name %j on write and on delete',
    async name => {
      await expect(contentInstaller._writeContent('skill', name, '# x', TYPE)).rejects.toThrow();
      await expect(contentInstaller._deleteContent('skill', name, TYPE)).rejects.toThrow();
      expect(existsSync(path.join(outside, 'keep.txt'))).toBe(true);
      expect(existsSync(skillsDir)).toBe(true);
    }
  );

  test('refuses to write through a symlinked skill directory that leaves the skills directory', async () => {
    await fs.symlink(outside, path.join(skillsDir, 'linked'), 'dir');
    await expect(contentInstaller._writeContent('skill', 'linked', '# x', TYPE)).rejects.toThrow();
    expect(existsSync(path.join(outside, 'SKILL.md'))).toBe(false);
  });

  test('delete removes the skill directory and leaves a sibling with the same prefix alone', async () => {
    await contentInstaller._writeContent('skill', 'foo', '# foo', TYPE);
    await contentInstaller._writeContent('skill', 'foo-other', '# other', TYPE);
    await contentInstaller._deleteContent('skill', 'foo', TYPE);
    expect(existsSync(path.join(skillsDir, 'foo'))).toBe(false);
    expect(existsSync(path.join(skillsDir, 'foo-other', 'SKILL.md'))).toBe(true);
  });

  test('delete of a symlinked skill directory removes the link, not its target', async () => {
    await fs.symlink(outside, path.join(skillsDir, 'linked'), 'dir');
    await contentInstaller._deleteContent('skill', 'linked', TYPE);
    expect(existsSync(path.join(skillsDir, 'linked'))).toBe(false);
    expect(existsSync(path.join(outside, 'keep.txt'))).toBe(true);
  });
});
