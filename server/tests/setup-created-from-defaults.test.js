// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * wasContentsCreatedFromDefaults(): only a contents directory that was missing
 * or empty before setup counts as created from server/defaults; such an
 * install skips every migration.
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-created-')));
fsSync.mkdirSync(path.join(ROOT, 'server', 'defaults', 'config'), { recursive: true });
fsSync.writeFileSync(path.join(ROOT, 'server', 'defaults', 'config', 'platform.json'), '{}');
process.env.APP_ROOT_DIR = ROOT;
process.env.CONTENTS_DIR = 'contents';

const { performInitialSetup, wasContentsCreatedFromDefaults, wasContentsFreshlySeeded } =
  await import('../utils/setupUtils.js');

const CONTENTS = path.join(ROOT, 'contents');

describe('wasContentsCreatedFromDefaults', () => {
  beforeEach(async () => {
    await fs.rm(CONTENTS, { recursive: true, force: true });
  });

  it('is true when contents/ did not exist', async () => {
    await performInitialSetup();
    assert.equal(wasContentsCreatedFromDefaults(), true);
    assert.equal(await fs.readFile(path.join(CONTENTS, 'config', 'platform.json'), 'utf8'), '{}');
  });

  it('is true for an empty directory, or a new volume holding only lost+found', async () => {
    await fs.mkdir(path.join(CONTENTS, 'lost+found'), { recursive: true });
    await performInitialSetup();
    assert.equal(wasContentsCreatedFromDefaults(), true);
  });

  it('is true when contents/ holds only empty directories (Docker volumes for data and uploads)', async () => {
    await fs.mkdir(path.join(CONTENTS, 'data'), { recursive: true });
    await fs.mkdir(path.join(CONTENTS, 'uploads', 'nested'), { recursive: true });
    await performInitialSetup();
    assert.equal(wasContentsCreatedFromDefaults(), true);
  });

  it('is false when a data volume holds documents from an earlier installation', async () => {
    await fs.mkdir(path.join(CONTENTS, 'data', 'chats'), { recursive: true });
    await fs.writeFile(path.join(CONTENTS, 'data', 'chats', 'old.json'), '{}');
    await performInitialSetup();
    assert.equal(wasContentsCreatedFromDefaults(), false);
  });

  it('is false when contents/ held files, even without a platform.json', async () => {
    await fs.mkdir(path.join(CONTENTS, 'apps'), { recursive: true });
    await fs.writeFile(path.join(CONTENTS, 'apps', 'old-app.json'), '{}');
    await performInitialSetup();
    assert.equal(wasContentsFreshlySeeded(), true);
    assert.equal(wasContentsCreatedFromDefaults(), false);
  });

  it('is false on the next start of the same installation', async () => {
    await performInitialSetup();
    await performInitialSetup();
    assert.equal(wasContentsCreatedFromDefaults(), false);
  });
});
