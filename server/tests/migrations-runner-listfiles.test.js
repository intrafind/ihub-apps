// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `ctx.listFiles` of a path that is a file, not a directory, lists nothing.
 *
 * macOS writes `.DS_Store` files into every folder it shows. A migration that
 * walks `contents/<dir>/*` and lists each entry (V217 does this for
 * `contents/integrations/`) used to fail with ENOTDIR on such a file and halt
 * the server start.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { runConfigMigrations } from '../migrations/runner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const V217 = 'V217__drop_legacy_integration_token_files.js';

describe('migration context listFiles on a file', () => {
  let tmp;
  let contentsDir;
  let migrationsDir;
  let defaultsDir;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-listfiles-'));
    contentsDir = path.join(tmp, 'contents');
    migrationsDir = path.join(tmp, 'migrations');
    defaultsDir = path.join(tmp, 'defaults');
    await fs.mkdir(path.join(contentsDir, 'config'), { recursive: true });
    await fs.mkdir(path.join(contentsDir, 'integrations', 'jira'), { recursive: true });
    await fs.mkdir(migrationsDir, { recursive: true });
    await fs.mkdir(defaultsDir, { recursive: true });
    await fs.writeFile(path.join(contentsDir, 'config', 'platform.json'), '{}');
    // An install that is past the baseline and has run everything up to V216.
    await fs.writeFile(
      path.join(contentsDir, '.migration-history.json'),
      JSON.stringify({
        schemaVersion: '1.0',
        migrations: [
          {
            version: '216',
            description: 'default_group_inheritance_chain',
            file: 'V216__default_group_inheritance_chain.js',
            checksum: 'not-checked-here',
            appliedAt: '2026-01-01T00:00:00.000Z',
            status: 'success'
          }
        ]
      })
    );
    await fs.copyFile(path.join(here, '..', 'migrations', V217), path.join(migrationsDir, V217));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('V217 runs past a .DS_Store file in contents/integrations', async () => {
    const integrations = path.join(contentsDir, 'integrations');
    await fs.writeFile(path.join(integrations, '.DS_Store'), 'Bud1');
    const cbc = { encrypted: 'x', iv: 'y', contextHash: 'z' };
    const gcm = { ...cbc, authTag: 't' };
    await fs.writeFile(path.join(integrations, 'jira', 'old.json'), JSON.stringify(cbc));
    await fs.writeFile(path.join(integrations, 'jira', 'new.json'), JSON.stringify(gcm));

    const result = await runConfigMigrations({
      contentsDir,
      migrationsDir,
      defaultsDir,
      freshlySeeded: false
    });

    expect(result.failed).toBe(0);
    expect(result.applied).toBe(1);
    const left = await fs.readdir(path.join(integrations, 'jira'));
    expect(left).toEqual(['new.json']);
  });
});
