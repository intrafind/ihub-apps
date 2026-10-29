// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The release workflow and the updater agree on what the archives are called
 * (the updater used to look for `-windows.tar.gz`; the workflow publishes
 * `-win.zip`), the workflow publishes and signs what the updater verifies,
 * and the launcher build-sea.cjs generates still compiles and applies
 * pending updates.
 *
 * Run: node --test server/tests/update-release-assets.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  detectArchiveFormat,
  getUpdateArchiveName,
  parseUpdateArchiveName
} from '../update/archiveNames.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const workflow = fs.readFileSync(path.join(repo, '.github/workflows/build-binaries.yml'), 'utf8');

describe('release archive names', () => {
  it('names the archive of every updater platform the way the workflow publishes it', () => {
    assert.equal(getUpdateArchiveName('v5.7.0', 'linux'), 'ihub-apps-v5.7.0-linux.tar.gz');
    assert.equal(getUpdateArchiveName('v5.7.0', 'macos'), 'ihub-apps-v5.7.0-macos.tar.gz');
    assert.equal(getUpdateArchiveName('v5.7.0', 'windows'), 'ihub-apps-v5.7.0-win.zip');
    assert.equal(getUpdateArchiveName('5.7.0', 'win'), 'ihub-apps-v5.7.0-win.zip');
  });

  it('is computed by the workflow through the same module, for every matrix platform', () => {
    assert.match(workflow, /node scripts\/update-archive-name\.js "\$VERSION" "\$MATRIX_PLATFORM"/);
    const platforms = [...workflow.matchAll(/^\s+platform: (\w+)$/gm)].map(m => m[1]);
    assert.deepEqual(platforms.sort(), ['linux', 'macos', 'win']);
    for (const platform of platforms) {
      const name = execFileSync(
        process.execPath,
        [path.join(repo, 'scripts/update-archive-name.js'), 'v1.2.3', platform],
        { encoding: 'utf8' }
      ).trim();
      assert.equal(name, getUpdateArchiveName('v1.2.3', platform));
      assert.ok(detectArchiveFormat(name));
      assert.ok(parseUpdateArchiveName(name));
    }
  });

  it('publishes and signs checksums.sha256 and the update manifest', () => {
    assert.match(workflow, /update-signing\.js checksums \.\/artifacts/);
    assert.match(workflow, /update-signing\.js sign \.\/artifacts\/checksums\.sha256/);
    assert.match(workflow, /update-signing\.js manifest dist-bin/);
    assert.match(workflow, /update-signing\.js sign dist-bin\/update-manifest\.json/);
    // The manifest has to be written after the last file lands in dist-bin.
    assert.ok(
      workflow.indexOf('update-signing.js manifest dist-bin') >
        workflow.indexOf('windows-check.bat')
    );
    assert.ok(
      workflow.indexOf('update-signing.js manifest dist-bin') <
        workflow.indexOf('Create platform-specific archive')
    );
  });
});

describe('generated launcher', () => {
  it('compiles and applies pending updates before it starts the server', () => {
    const source = fs.readFileSync(path.join(repo, 'build-sea.cjs'), 'utf8');
    const start = source.indexOf('const launcherScript = `') + 'const launcherScript = '.length;
    const end = source.indexOf('`;\n\n// Build our application');
    assert.ok(start > 30 && end > start);
    const launcher = new Function(`return ${source.slice(start, end + 1)}`)();
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-launcher-')),
      'launcher.cjs'
    );
    fs.writeFileSync(file, launcher);
    execFileSync(process.execPath, ['--check', file]);
    assert.match(launcher, /require\('\.\/server\/update\/swap\.cjs'\)/);
    assert.match(launcher, /applyPendingUpdate\(binDir/);
    assert.match(launcher, /recordServerExit\(binDir/);
    assert.match(launcher, /IHUB_LAUNCHER_PROTOCOL/);
    assert.match(launcher, /runUpdateCLI\(subcommand, force, process\.argv\)/);
  });
});
