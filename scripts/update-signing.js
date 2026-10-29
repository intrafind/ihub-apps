#!/usr/bin/env node
// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Release-side tooling for update archives: the manifest every archive carries,
 * the checksum file published next to the archives, and their Ed25519
 * signatures. The updater's side is server/update/.
 *
 *   node scripts/update-signing.js keygen
 *       Print a new Ed25519 key pair (private key PKCS#8 PEM, public key SPKI PEM).
 *   node scripts/update-signing.js manifest <dir> [--platform=linux|macos|windows] [--arch=x64]
 *       Write <dir>/update-manifest.json: version, platform, arch, bundled Node
 *       version, highest config migration and the SHA-256 of every file.
 *   node scripts/update-signing.js strip-bin-links <dir>
 *       Remove the node_modules/.bin directories npm creates. They hold
 *       symlinks, which the updater refuses in an archive; nothing runs them.
 *   node scripts/update-signing.js checksums <dir> [--out=<file>]
 *       Write checksums.sha256 (sha256sum format) for every archive below <dir>.
 *   node scripts/update-signing.js sign <file> [--require]
 *       Write <file>.sig with the key(s) in UPDATE_SIGNING_PRIVATE_KEY and
 *       UPDATE_SIGNING_PRIVATE_KEY_NEXT. Without a key it warns and writes
 *       nothing, unless --require is given.
 *   node scripts/update-signing.js verify <file> [--key=<public-key.pem>]
 *       Check <file>.sig against the embedded keys (and --key).
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign
} from 'node:crypto';
import { createReadStream, existsSync, promises as fs, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyIdOf, loadTrustedKeys, verifyDetachedSignature } from '../server/update/signature.js';
import { ARCHIVE_EXTENSIONS } from '../server/update/archiveNames.js';

/** Bumped when the launcher's update handling changes (server/update/swap.cjs). */
const REQUIRES_LAUNCHER = 2;
const MANIFEST_FILE = 'update-manifest.json';
const SIGNATURE_SUFFIX = '.sig';

function option(args, name) {
  const found = args.find(a => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : undefined;
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function listFiles(dir, base = dir, out = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await listFiles(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
    else if (entry.isSymbolicLink()) {
      throw new Error(
        `${full} is a symbolic link; the updater refuses archives that contain links`
      );
    }
  }
  return out;
}

function detectPlatform(dir) {
  const launcher = readdirSync(dir).find(f => /^ihub-apps-v.*-(linux|macos|win\.bat)$/.test(f));
  if (launcher?.endsWith('-win.bat')) return 'windows';
  if (launcher?.endsWith('-macos')) return 'macos';
  if (launcher?.endsWith('-linux')) return 'linux';
  return { win32: 'windows', darwin: 'macos' }[process.platform] || 'linux';
}

function highestMigration(dir) {
  const migrations = path.join(dir, 'server', 'migrations');
  if (!existsSync(migrations)) return null;
  const versions = readdirSync(migrations)
    .map(f => /^V(\d+)__/.exec(f)?.[1])
    .filter(Boolean)
    .map(Number);
  return versions.length ? Math.max(...versions) : null;
}

/**
 * Remove every `node_modules/.bin` below `dir`. npm links package executables
 * there as symlinks on Linux and macOS; a release archive must not contain
 * links (the updater rejects them), and the server never runs those
 * executables.
 * @returns {Promise<number>} Directories removed
 */
export async function stripBinLinks(dir) {
  let removed = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.name === '.bin' && path.basename(dir) === 'node_modules') {
      await fs.rm(full, { recursive: true, force: true });
      removed++;
    } else if (entry.isDirectory()) {
      removed += await stripBinLinks(full);
    }
  }
  return removed;
}

export async function writeManifest(dir, { platform, arch } = {}) {
  const files = {};
  // Code-point order, independent of locale: the manifest must be byte-identical on every runner.
  for (const rel of (await listFiles(dir)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (rel === MANIFEST_FILE || rel === MANIFEST_FILE + SIGNATURE_SUFFIX) continue;
    files[rel] = await sha256(path.join(dir, rel));
  }
  const manifest = {
    schema: 1,
    product: 'ihub-apps',
    version: readFileSync(path.join(dir, 'version.txt'), 'utf8').trim(),
    platform: platform || detectPlatform(dir),
    arch: arch || process.arch,
    nodeVersion: process.version,
    requiresLauncher: REQUIRES_LAUNCHER,
    minUpdateFrom: process.env.UPDATE_MIN_UPDATE_FROM || null,
    maxMigrationVersion: highestMigration(dir),
    createdAt: new Date().toISOString(),
    files
  };
  await fs.writeFile(path.join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  // A manifest signed before this rewrite no longer matches it.
  await fs.rm(path.join(dir, MANIFEST_FILE + SIGNATURE_SUFFIX), { force: true });
  return manifest;
}

export async function writeChecksums(dir, out) {
  const archives = (await listFiles(dir))
    .filter(rel => ARCHIVE_EXTENSIONS.some(ext => rel.toLowerCase().endsWith(ext)))
    .sort((a, b) => path.posix.basename(a).localeCompare(path.posix.basename(b)));
  const names = new Set();
  const lines = [];
  for (const rel of archives) {
    const name = path.posix.basename(rel);
    if (names.has(name)) throw new Error(`Two archives are named ${name}`);
    names.add(name);
    lines.push(`${await sha256(path.join(dir, rel))}  ${name}`);
  }
  await fs.writeFile(out, `${lines.join('\n')}\n`);
  return lines;
}

function signingKeys() {
  return ['UPDATE_SIGNING_PRIVATE_KEY', 'UPDATE_SIGNING_PRIVATE_KEY_NEXT']
    .map(name => process.env[name])
    .filter(value => value && value.trim())
    .map(pem => createPrivateKey(pem.replace(/\\n/g, '\n')));
}

export async function signFile(file, { require: required = false } = {}) {
  const keys = signingKeys();
  if (keys.length === 0) {
    const message = `No UPDATE_SIGNING_PRIVATE_KEY set; ${path.basename(file)} is NOT signed`;
    if (required) throw new Error(message);
    console.log(`::warning::${message}. Installations refuse unsigned updates by default.`);
    return null;
  }
  const data = await fs.readFile(file);
  const signatures = keys.map(key => ({
    keyId: keyIdOf(createPublicKey(key)),
    signature: sign(null, data, key).toString('base64')
  }));
  // A release signed with a key iHub does not ship is refused by every
  // installation that has not added that key to update.trustedPublicKeys.
  const embedded = new Set(loadTrustedKeys([]).keys.map(k => k.keyId));
  for (const { keyId } of signatures) {
    if (!embedded.has(keyId)) {
      console.log(
        `::warning::Signing key ${keyId} is not in server/update/trustedKeys.js; ` +
          'installations will not trust this release unless they add the key themselves.'
      );
    }
  }
  const sigFile = file + SIGNATURE_SUFFIX;
  await fs.writeFile(sigFile, `${JSON.stringify({ algorithm: 'ed25519', signatures }, null, 2)}\n`);
  console.log(`Signed ${path.basename(file)} with ${signatures.map(s => s.keyId).join(', ')}`);
  return signatures;
}

async function main(argv) {
  const [command, target, ...rest] = argv;
  switch (command) {
    case 'keygen': {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      console.log(privateKey.export({ type: 'pkcs8', format: 'pem' }));
      console.log(publicKey.export({ type: 'spki', format: 'pem' }));
      console.log(`keyId: ${keyIdOf(publicKey)}`);
      return;
    }
    case 'manifest': {
      const manifest = await writeManifest(target, {
        platform: option(rest, 'platform'),
        arch: option(rest, 'arch')
      });
      console.log(
        `Wrote ${MANIFEST_FILE}: ${manifest.version} ${manifest.platform}/${manifest.arch}, ` +
          `${Object.keys(manifest.files).length} files`
      );
      return;
    }
    case 'strip-bin-links': {
      console.log(`Removed ${await stripBinLinks(target)} node_modules/.bin directories`);
      return;
    }
    case 'checksums': {
      const out = option(rest, 'out') || path.join(target, 'checksums.sha256');
      const lines = await writeChecksums(target, out);
      console.log(`Wrote ${out} (${lines.length} archives)`);
      return;
    }
    case 'sign':
      await signFile(target, { require: rest.includes('--require') });
      return;
    case 'verify': {
      const keyFile = option(rest, 'key');
      const { keys } = loadTrustedKeys(keyFile ? [readFileSync(keyFile, 'utf8')] : []);
      const sigFile = target + SIGNATURE_SUFFIX;
      const result = verifyDetachedSignature(
        await fs.readFile(target),
        existsSync(sigFile) ? await fs.readFile(sigFile) : null,
        keys
      );
      console.log(JSON.stringify(result));
      if (result.status !== 'valid') process.exitCode = 1;
      return;
    }
    default:
      console.error(
        'Usage: node scripts/update-signing.js keygen|manifest|strip-bin-links|checksums|sign|verify …'
      );
      process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`error: ${error.message}`);
    process.exit(1);
  });
}
