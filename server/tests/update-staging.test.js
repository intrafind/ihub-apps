// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "Install from file" end to end through services/updateService.js: release
 * archives built and signed the way the release workflow does it
 * (scripts/update-signing.js), staged from a path on the server, verified
 * (signature, manifest, checksum, platform, architecture, version) and
 * applied.
 *
 * Run: node --test server/tests/update-staging.test.js
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-update-staging-'));
const root = path.join(tmp, 'install');
fs.mkdirSync(root);
// Must be set before config.js is imported: the service resolves the
// installation directory from it, exactly as under the launcher.
process.env.APP_ROOT_DIR = root;
delete process.env.APP_VERSION;

const service = await import('../services/updateService.js');
const swap = (await import('../update/swap.cjs')).default;
const { writeManifest, signFile, writeChecksums } = await import('../../scripts/update-signing.js');

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const otherKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
const next = generateKeyPairSync('ed25519');
const nextPrivatePem = next.privateKey.export({ type: 'pkcs8', format: 'pem' });
const nextPublicPem = next.publicKey.export({ type: 'spki', format: 'pem' });

let settings;
service.setUpdateSettingsProvider(() => settings);

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

function resetInstall() {
  for (const entry of fs.readdirSync(root)) fs.rmSync(path.join(root, entry), { recursive: true });
  write(path.join(root, 'version.txt'), '1.0.0');
  write(path.join(root, 'server', 'server.js'), 'old server');
  write(path.join(root, 'public', 'index.html'), 'old ui');
  write(path.join(root, 'ihub-apps-v1.0.0-linux'), '#!/bin/bash');
  write(path.join(root, 'contents', 'config', 'platform.json'), '{}');
}

let counter = 0;
/**
 * Build a release archive.
 * @returns {Promise<string>} Path of the archive (in its own directory)
 */
async function buildRelease({
  version = '2.0.0',
  platform = 'linux',
  arch = process.arch,
  manifest = true,
  signWith = privatePem,
  alsoSignWith,
  tamper,
  extra,
  checksums = false,
  signChecksumsWith
} = {}) {
  const dir = path.join(tmp, `release-${++counter}`);
  const src = path.join(dir, 'src');
  write(path.join(src, 'version.txt'), version);
  write(path.join(src, 'server', 'server.js'), `server ${version}`);
  write(path.join(src, 'server', 'update', 'swap.cjs'), 'module.exports = {};');
  write(path.join(src, 'public', 'index.html'), `ui ${version}`);
  write(path.join(src, 'launcher.cjs'), 'launcher');
  write(
    path.join(src, `ihub-apps-v${version}-${platform === 'windows' ? 'win.bat' : platform}`),
    'x'
  );
  write(path.join(src, 'config.env'), 'PORT=3001');
  extra?.(src);
  if (manifest) {
    await writeManifest(src, { platform, arch });
    if (signWith) {
      process.env.UPDATE_SIGNING_PRIVATE_KEY = signWith;
      if (alsoSignWith) process.env.UPDATE_SIGNING_PRIVATE_KEY_NEXT = alsoSignWith;
      await signFile(path.join(src, 'update-manifest.json'), { require: true });
      delete process.env.UPDATE_SIGNING_PRIVATE_KEY;
      delete process.env.UPDATE_SIGNING_PRIVATE_KEY_NEXT;
    }
  }
  tamper?.(src);
  const name = `ihub-apps-v${version}-${platform === 'windows' ? 'win' : platform}.tar.gz`;
  const archive = path.join(dir, name);
  execFileSync('tar', ['-czf', archive, '.'], { cwd: src });
  fs.rmSync(src, { recursive: true });
  if (checksums) {
    await writeChecksums(dir, path.join(dir, 'checksums.sha256'));
    if (signChecksumsWith) {
      process.env.UPDATE_SIGNING_PRIVATE_KEY = signChecksumsWith;
      await signFile(path.join(dir, 'checksums.sha256'), { require: true });
      delete process.env.UPDATE_SIGNING_PRIVATE_KEY;
    }
  }
  return archive;
}

const codes = list => list.map(entry => entry.code);

before(() => resetInstall());
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => {
  resetInstall();
  settings = { trustedPublicKeys: [publicPem], allowUnsigned: false };
  delete process.env.IHUB_LAUNCHER_PROTOCOL;
});

describe('stageLocalFile', () => {
  it('stages a signed release and summarises it', async () => {
    const summary = await service.stageLocalFile(await buildRelease());
    assert.equal(summary.accepted, true, JSON.stringify(summary.problems));
    assert.equal(summary.version, '2.0.0');
    assert.equal(summary.comparison, 'upgrade');
    assert.equal(summary.platform, 'linux');
    assert.equal(summary.arch, process.arch);
    assert.equal(summary.trusted, true);
    assert.deepEqual(summary.signature.via, 'manifest');
    assert.equal(summary.source, 'local');
    assert.match(summary.archiveSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(summary.ignoredEntries, ['config.env']);
    assert.deepEqual(summary.requiresConfirmation, { downgrade: false, unsigned: false });
    assert.ok(codes(summary.warnings).includes('checksum-missing'));

    const status = service.getUpdateStatus();
    assert.equal(status.staged.version, '2.0.0');
    assert.equal(status.archiveNameExample, 'ihub-apps-v<version>-linux.tar.gz');
    assert.equal(
      fs.readFileSync(path.join(root, 'version.txt'), 'utf8'),
      '1.0.0',
      'nothing applied yet'
    );
    assert.equal(fs.existsSync(path.join(root, '.update-staging', 'config.env')), false);
  });

  it('rejects an archive changed after signing', async () => {
    const archive = await buildRelease({
      tamper: src => write(path.join(src, 'server', 'server.js'), 'backdoor')
    });
    const summary = await service.stageLocalFile(archive);
    assert.equal(summary.accepted, false);
    assert.ok(codes(summary.problems).includes('manifest-mismatch'));
    assert.equal(fs.existsSync(path.join(root, '.update-staging')), false);
  });

  it('rejects a file added after signing', async () => {
    const archive = await buildRelease({
      tamper: src => write(path.join(src, 'server', 'extra.js'), 'x')
    });
    const summary = await service.stageLocalFile(archive);
    assert.ok(codes(summary.problems).includes('manifest-mismatch'));
  });

  it('refuses an archive signed with an unknown key unless unsigned archives are allowed', async () => {
    const archive = await buildRelease({ signWith: otherKey });
    const refused = await service.stageLocalFile(archive);
    assert.equal(refused.accepted, false);
    assert.ok(codes(refused.problems).includes('untrusted'));
    assert.equal(refused.signature.status, 'unknown-key');

    settings = { trustedPublicKeys: [publicPem], allowUnsigned: true };
    const allowed = await service.stageLocalFile(archive);
    assert.equal(allowed.accepted, true);
    assert.equal(allowed.requiresConfirmation.unsigned, true);
    assert.ok(codes(allowed.warnings).includes('unsigned'));
  });

  it('verifies a release signed with the "next" key, and one signed with both during a rotation', async () => {
    settings = { trustedPublicKeys: [publicPem, nextPublicPem], allowUnsigned: false };
    const nextOnly = await service.stageLocalFile(await buildRelease({ signWith: nextPrivatePem }));
    assert.equal(nextOnly.trusted, true, JSON.stringify(nextOnly.problems));

    // An installation that only knows the old key accepts a dual-signed release...
    settings = { trustedPublicKeys: [publicPem], allowUnsigned: false };
    const both = await service.stageLocalFile(
      await buildRelease({ signWith: nextPrivatePem, alsoSignWith: privatePem })
    );
    assert.equal(both.trusted, true, JSON.stringify(both.problems));

    // ...but not one signed with the new key alone.
    const strandedRelease = await service.stageLocalFile(
      await buildRelease({ signWith: nextPrivatePem })
    );
    assert.equal(strandedRelease.accepted, false);
  });

  it('refuses everything unsigned when no key is configured', async () => {
    settings = { trustedPublicKeys: [], allowUnsigned: false };
    const summary = await service.stageLocalFile(await buildRelease());
    assert.equal(summary.accepted, false);
    assert.match(
      summary.problems.find(p => p.code === 'untrusted').message,
      /no update signing key/
    );
  });

  it('rejects the wrong platform and the wrong architecture', async () => {
    const windows = await service.stageLocalFile(await buildRelease({ platform: 'windows' }));
    assert.ok(codes(windows.problems).includes('wrong-platform'));

    const otherArch = process.arch === 'arm64' ? 'x64' : 'arm64';
    const arch = await service.stageLocalFile(await buildRelease({ arch: otherArch }));
    assert.ok(codes(arch.problems).includes('wrong-arch'));
  });

  it('asks for confirmation of a downgrade or the same version', async () => {
    write(path.join(root, 'version.txt'), '3.0.0');
    const summary = await service.stageLocalFile(await buildRelease({ version: '2.0.0' }));
    assert.equal(summary.accepted, true);
    assert.equal(summary.comparison, 'downgrade');
    assert.equal(summary.requiresConfirmation.downgrade, true);
    await assert.rejects(service.applyUpdate(), error => error.code === 'confirm-downgrade');
  });

  it('refuses an update that skips a required intermediate version', async () => {
    process.env.UPDATE_MIN_UPDATE_FROM = '1.5.0';
    try {
      const summary = await service.stageLocalFile(await buildRelease());
      assert.ok(codes(summary.problems).includes('min-update-from'));
    } finally {
      delete process.env.UPDATE_MIN_UPDATE_FROM;
    }
  });

  it('trusts a legacy archive (no manifest) through a signed checksums.sha256 next to it', async () => {
    const archive = await buildRelease({
      manifest: false,
      checksums: true,
      signChecksumsWith: privatePem
    });
    const summary = await service.stageLocalFile(archive);
    assert.equal(summary.accepted, true, JSON.stringify(summary.problems));
    assert.equal(summary.signature.via, 'checksums');
    assert.equal(summary.checksum, 'match');
    assert.ok(codes(summary.warnings).includes('legacy-archive'));
  });

  it('rejects an archive that does not match its published checksum', async () => {
    const archive = await buildRelease({ checksums: true });
    fs.appendFileSync(archive, Buffer.from('garbage'));
    const summary = await service
      .stageLocalFile(archive)
      .catch(error => ({ accepted: false, problems: [{ code: error.code }] }));
    assert.equal(summary.accepted, false);
  });

  it('does not run the bundled node of an unsigned archive while staging', async t => {
    if (process.platform === 'win32') return t.skip('shell script stands in for node');
    const marker = path.join(tmp, `node-ran-${counter}`);
    const withNode = extra => src => {
      write(path.join(src, 'node'), `#!/bin/sh\ntouch "${marker}"\necho v99.0.0\n`);
      fs.chmodSync(path.join(src, 'node'), 0o755);
      extra?.(src);
    };
    settings = { trustedPublicKeys: [publicPem], allowUnsigned: true };
    const unsigned = await service.stageLocalFile(
      await buildRelease({ signWith: null, extra: withNode() })
    );
    assert.equal(unsigned.accepted, true);
    assert.equal(fs.existsSync(marker), false, 'unsigned code ran before the confirmation');

    const signed = await service.stageLocalFile(await buildRelease({ extra: withNode() }));
    assert.equal(signed.trusted, true);
    assert.equal(signed.nodeVersion, 'v99.0.0');
    assert.equal(fs.existsSync(marker), true);
  });

  it('refuses to stage while an update is scheduled for the next start', async () => {
    process.env.IHUB_LAUNCHER_PROTOCOL = String(swap.LAUNCHER_PROTOCOL);
    await service.stageLocalFile(await buildRelease());
    await service.applyUpdate();
    await assert.rejects(
      service.stageLocalFile(await buildRelease({ version: '3.0.0' })),
      error => error.code === 'update-pending'
    );
    await assert.rejects(service.rollback(), /No backup|already scheduled/);
    assert.equal(
      fs.readFileSync(path.join(root, '.update-staging', 'version.txt'), 'utf8'),
      '2.0.0'
    );
  });

  it('serialises operations with an exclusive lock and takes over a stale one', async () => {
    const lockFile = path.join(root, '.update-lock');
    // An empty file is a lock caught mid-write: fresh by mtime, so it is held.
    fs.writeFileSync(lockFile, '');
    await assert.rejects(
      service.stageLocalFile(await buildRelease()),
      error => error.status === 409
    );

    // Staleness is the lock's mtime (the heartbeat touches it), not its content.
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000);
    fs.utimesSync(lockFile, elevenMinutesAgo, elevenMinutesAgo);
    const summary = await service.stageLocalFile(await buildRelease());
    assert.equal(summary.accepted, true);
    assert.equal(fs.existsSync(lockFile), false, 'released afterwards');
  });

  it('rejects bad paths without echoing file contents', async () => {
    const secret = path.join(tmp, 'secret.txt');
    write(secret, 'TOP-SECRET-CONTENT');
    for (const [input, pattern] of [
      ['relative/path.tar.gz', /absolute/],
      [path.join(tmp, 'missing.tar.gz'), /not found/],
      [secret, /Not a release archive/],
      [tmp, /Not a release archive/],
      ['', /required/]
    ]) {
      await assert.rejects(service.stageLocalFile(input), error => {
        assert.ok(error instanceof service.UpdateRequestError);
        assert.match(error.message, pattern);
        assert.doesNotMatch(error.message, /TOP-SECRET/);
        return true;
      });
    }

    const dir = path.join(tmp, 'looks-like.tar.gz');
    fs.mkdirSync(dir);
    await assert.rejects(service.stageLocalFile(dir), /not a regular file|could not be opened/);
  });

  it('lists archives in the updates/ drop-in folder', async () => {
    const archive = await buildRelease();
    fs.mkdirSync(path.join(root, 'updates'));
    fs.copyFileSync(archive, path.join(root, 'updates', path.basename(archive)));
    write(path.join(root, 'updates', 'notes.txt'), 'x');
    const { files } = await service.listLocalCandidates();
    assert.deepEqual(
      files.map(f => [f.name, f.version, f.platform]),
      [['ihub-apps-v2.0.0-linux.tar.gz', '2.0.0', 'linux']]
    );
  });
});

describe('stageUploadedFile', () => {
  it('stages the parts multer stored in the upload directory, by field name', async () => {
    const archive = await buildRelease({ checksums: true, signChecksumsWith: privatePem });
    const uploadDir = await service.createWorkDir('upload');
    fs.copyFileSync(archive, path.join(uploadDir, 'archive'));
    fs.copyFileSync(
      path.join(path.dirname(archive), 'checksums.sha256'),
      path.join(uploadDir, 'checksums')
    );
    fs.copyFileSync(
      path.join(path.dirname(archive), 'checksums.sha256.sig'),
      path.join(uploadDir, 'checksumsSig')
    );
    const summary = await service.stageUploadedFile(uploadDir, {
      archiveName: path.basename(archive),
      hasChecksums: true,
      hasChecksumsSig: true
    });
    assert.equal(summary.accepted, true, JSON.stringify(summary.problems));
    assert.equal(summary.source, 'upload');
    assert.equal(summary.checksum, 'match');
  });

  it('refuses a directory outside .update-tmp and a name that is not an archive', async () => {
    await assert.rejects(
      service.stageUploadedFile(tmp, { archiveName: 'ihub-apps-v2.0.0-linux.tar.gz' }),
      /No archive was uploaded/
    );
    const uploadDir = await service.createWorkDir('upload');
    await assert.rejects(
      service.stageUploadedFile(uploadDir, { archiveName: 'notes.txt' }),
      /Not a release archive/
    );
  });
});

describe('applyUpdate / rollback', () => {
  it('hands the swap to a current launcher and swaps nothing while running', async () => {
    process.env.IHUB_LAUNCHER_PROTOCOL = String(swap.LAUNCHER_PROTOCOL);
    await service.stageLocalFile(await buildRelease());
    const result = await service.applyUpdate();
    assert.equal(result.applyMode, 'swap-on-start');
    assert.equal(result.configSnapshot, true);
    assert.equal(fs.readFileSync(path.join(root, 'version.txt'), 'utf8'), '1.0.0');
    const pending = swap.readPending(root);
    assert.equal(pending.targetVersion, '2.0.0');
    assert.equal(service.getUpdateStatus().pendingRestart, true);

    // What the launcher does on the restart that follows.
    swap.applyPendingUpdate(root);
    assert.equal(fs.readFileSync(path.join(root, 'version.txt'), 'utf8'), '2.0.0');
    service.confirmUpdateOnStartup();
    assert.equal(service.getUpdateStatus().lastResult.status, 'success');
  });

  it('swaps in-process under a launcher that predates swap-on-start', async () => {
    const summary = await service.stageLocalFile(await buildRelease());
    assert.equal(summary.applyMode, 'in-process');
    assert.ok(codes(summary.warnings).includes('legacy-launcher'));
    const result = await service.applyUpdate();
    assert.equal(result.applyMode, 'in-process');
    assert.equal(fs.readFileSync(path.join(root, 'version.txt'), 'utf8'), '2.0.0');
    assert.equal(swap.readAttempt(root).targetVersion, '2.0.0');

    const rolledBack = await service.rollback({ restoreConfig: true, inProcess: true });
    assert.equal(rolledBack.restoredVersion, '1.0.0');
    assert.equal(fs.readFileSync(path.join(root, 'server', 'server.js'), 'utf8'), 'old server');
  });

  it('requires the typed version for an unsigned archive', async () => {
    settings = { trustedPublicKeys: [], allowUnsigned: true };
    await service.stageLocalFile(await buildRelease({ signWith: null }));
    await assert.rejects(service.applyUpdate(), error => error.code === 'confirm-unsigned');
    await assert.rejects(
      service.applyUpdate({ confirmUnsigned: 'yes' }),
      error => error.code === 'confirm-unsigned'
    );

    settings = { trustedPublicKeys: [], allowUnsigned: false };
    await assert.rejects(
      service.applyUpdate({ confirmUnsigned: '2.0.0' }),
      error => error.code === 'unsigned-not-allowed'
    );

    settings = { trustedPublicKeys: [], allowUnsigned: true };
    const result = await service.applyUpdate({ confirmUnsigned: '2.0.0', inProcess: true });
    assert.equal(result.newVersion, '2.0.0');
  });

  it('refuses to apply without a staged, verified release', async () => {
    await assert.rejects(service.applyUpdate(), /No staged update/);
    fs.mkdirSync(path.join(root, '.update-staging'));
    await assert.rejects(service.applyUpdate(), /no verification record/);
  });

  it('discards a staged release', async () => {
    await service.stageLocalFile(await buildRelease());
    await service.discardStaged();
    assert.equal(service.getUpdateStatus().hasStaged, false);
  });
});

describe('evaluateChecksum', () => {
  const hash = 'a'.repeat(64);
  it('matches by hash, also under another file name, with CRLF and binary markers', () => {
    assert.equal(
      service.evaluateChecksum(`${hash} *other-name.tar.gz\r\n`, 'x.tar.gz', [hash]),
      'match'
    );
  });
  it('flags a listed name with another hash', () => {
    assert.equal(
      service.evaluateChecksum(`${'b'.repeat(64)}  x.tar.gz\n`, 'x.tar.gz', [hash]),
      'mismatch'
    );
  });
  it('distinguishes a missing file from one that does not list the archive', () => {
    assert.equal(service.evaluateChecksum(null, 'x.tar.gz', [hash]), 'missing');
    assert.equal(
      service.evaluateChecksum(`${'b'.repeat(64)}  y.tar.gz\n`, 'x.tar.gz', [hash]),
      'not-listed'
    );
  });
});
