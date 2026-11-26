// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A throw-away self-signed certificate for `127.0.0.1`, for the specs that make
 * a real TLS handshake against a local server (the SSL whitelist specs). It
 * needs the `openssl` binary, which is looked up in fixed system locations
 * (never through `PATH`) or taken from `OPENSSL_BIN`; callers skip their
 * handshake specs without it.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OPENSSL_LOCATIONS = [
  '/usr/bin/openssl',
  '/bin/openssl',
  '/usr/local/bin/openssl',
  '/opt/homebrew/bin/openssl'
];

const opensslBinary =
  process.env.OPENSSL_BIN || OPENSSL_LOCATIONS.find(location => fs.existsSync(location)) || null;

/** Whether the `openssl` binary is available. */
export const opensslAvailable =
  opensslBinary !== null && spawnSync(opensslBinary, ['version']).status === 0;

/**
 * Create a certificate valid for one day for `127.0.0.1` in a new temp directory.
 *
 * @returns {{ dir: string, key: string, cert: string, remove: () => void }} the PEM contents
 *   of the key and certificate, and a function that deletes the directory
 * @throws {Error} when `openssl` is not available or fails
 */
export function createSelfSignedCertificate() {
  if (!opensslAvailable) throw new Error('openssl is not available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-tls-'));
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const made = spawnSync(opensslBinary, [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyFile,
    '-out',
    certFile,
    '-days',
    '1',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1'
  ]);
  if (made.status !== 0) throw new Error(`openssl failed: ${made.stderr}`);
  return {
    dir,
    key: fs.readFileSync(keyFile),
    cert: fs.readFileSync(certFile),
    remove: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}
