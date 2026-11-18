#!/usr/bin/env node
// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Checks the library kit for HTML artifacts (#3822) against npm: for every
 * library in `shared/artifactLibraries.js`, downloads the package tarball at
 * the exact version from the npm registry, checks it against the registry's
 * own sha512 integrity, takes the built file the manifest names, and compares
 * it byte for byte with the vendored copy in `server/artifactLibraries/` and
 * with the manifest's size and SHA-256.
 *
 *   node scripts/check-artifact-libraries.js           # check
 *   node scripts/check-artifact-libraries.js --write   # copy the files from npm and print the manifest values
 *
 * Exits non-zero when anything differs. Needs network access to the npm
 * registry. Runs no other program: the tarball is fetched and unpacked here.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { ARTIFACT_LIBRARIES } from '../shared/artifactLibraries.js';

const REGISTRY = 'https://registry.npmjs.org';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = path.join(root, 'server', 'artifactLibraries');
const write = process.argv.includes('--write');
const sha256 = data => createHash('sha256').update(data).digest('hex');

/** Read a NUL-terminated string field of a tar header. */
function field(header, start, length) {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

/**
 * One file out of an (uncompressed) ustar archive, or null.
 *
 * @param {Buffer} tar
 * @param {string} wanted - Path inside the archive, e.g. `package/dist/d3.min.js`.
 * @returns {Buffer|null}
 */
function fileFromTar(tar, wanted) {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    const name = field(header, 0, 100);
    if (!name) return null;
    const prefix = field(header, 345, 155);
    const size = Number.parseInt(field(header, 124, 12).trim() || '0', 8);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const body = offset + 512;
    if (fullName === wanted) return tar.subarray(body, body + size);
    offset = body + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** The tarball of a package version, checked against the registry's integrity. */
async function packageTarball(name, version) {
  const metaResponse = await fetch(`${REGISTRY}/${encodeURIComponent(name)}/${version}`);
  if (!metaResponse.ok)
    throw new Error(`${name}@${version}: registry answered ${metaResponse.status}`);
  const { dist } = await metaResponse.json();
  const response = await fetch(dist.tarball);
  if (!response.ok) throw new Error(`${dist.tarball}: ${response.status}`);
  const tgz = Buffer.from(await response.arrayBuffer());
  const [algorithm, expected] = String(dist.integrity).split('-');
  const actual = createHash(algorithm).update(tgz).digest('base64');
  if (algorithm !== 'sha512' || actual !== expected) {
    throw new Error(`${name}@${version}: tarball does not match the registry's integrity`);
  }
  return { tar: gunzipSync(tgz), integrity: dist.integrity };
}

let failures = 0;
for (const library of ARTIFACT_LIBRARIES) {
  const spec = `${library.npm.package}@${library.version}`;
  const { tar, integrity } = await packageTarball(library.npm.package, library.version);
  const upstream = fileFromTar(tar, `package/${library.npm.path}`);
  if (!upstream) {
    failures += 1;
    console.error(`✗ ${spec}: ${library.npm.path} is not in the package`);
    continue;
  }
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
      `✓ ${spec} (${library.npm.path}, ${upstream.length} bytes, integrity ${integrity})`
    );
  }
}

if (failures) {
  console.error(`\n${failures} library file(s) do not match their npm package.`);
  process.exit(1);
}
