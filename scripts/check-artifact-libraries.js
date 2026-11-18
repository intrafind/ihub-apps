#!/usr/bin/env node
// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Checks the library kit for HTML artifacts (#3822) against npm: for every
 * library in `shared/artifactLibraries.js`, downloads the package at the exact
 * version with `npm pack`, takes the built file the manifest names, and
 * compares it byte for byte with the vendored copy in
 * `server/artifactLibraries/` and with the manifest's size and SHA-256.
 *
 *   node scripts/check-artifact-libraries.js           # check
 *   node scripts/check-artifact-libraries.js --write   # copy the files from npm and print the manifest values
 *
 * Exits non-zero when anything differs. Needs network access to the npm registry.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_LIBRARIES } from '../shared/artifactLibraries.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = path.join(root, 'server', 'artifactLibraries');
const write = process.argv.includes('--write');
const sha256 = data => createHash('sha256').update(data).digest('hex');

const work = mkdtempSync(path.join(tmpdir(), 'artifact-libraries-'));
let failures = 0;
try {
  for (const library of ARTIFACT_LIBRARIES) {
    const spec = `${library.npm.package}@${library.version}`;
    const [packed] = JSON.parse(
      execFileSync('npm', ['pack', spec, '--json', '--silent', '--pack-destination', work], {
        encoding: 'utf8'
      })
    );
    const tarball = path.join(work, packed.filename);
    const unpacked = path.join(work, library.id);
    execFileSync('mkdir', ['-p', unpacked]);
    execFileSync('tar', ['-xzf', tarball, '-C', unpacked]);
    const upstream = readFileSync(path.join(unpacked, 'package', library.npm.path));
    const vendoredPath = path.join(vendorDir, library.file);

    if (write) {
      writeFileSync(vendoredPath, upstream);
      console.log(
        `${library.id}: wrote ${library.file} — bytes: ${upstream.length}, sha256: '${sha256(upstream)}'`
      );
      continue;
    }

    const problems = [];
    let vendored = null;
    try {
      vendored = readFileSync(vendoredPath);
    } catch {
      problems.push(`${library.file} is missing`);
    }
    if (vendored && !vendored.equals(upstream)) {
      problems.push(`${library.file} differs from ${library.npm.path} in ${spec}`);
    }
    if (upstream.length !== library.bytes) {
      problems.push(`the manifest says ${library.bytes} bytes, npm has ${upstream.length}`);
    }
    if (sha256(upstream) !== library.sha256) {
      problems.push(`the manifest's sha256 does not match ${spec} (${sha256(upstream)})`);
    }
    if (problems.length) {
      failures += 1;
      console.error(`✗ ${spec}: ${problems.join('; ')}`);
    } else {
      console.log(
        `✓ ${spec} (${library.npm.path}, ${upstream.length} bytes, integrity ${packed.integrity})`
      );
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} library file(s) do not match their npm package.`);
  process.exit(1);
}
