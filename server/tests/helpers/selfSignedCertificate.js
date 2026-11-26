// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A throw-away self-signed certificate for `127.0.0.1`, for the specs that make
 * a real TLS handshake against a local server (the SSL whitelist specs). It
 * needs the `openssl` binary; callers skip their handshake specs without it.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Whether the `openssl` binary is available. */
export const opensslAvailable = spawnSync('openssl', ['version']).status === 0;

/**
 * Create a certificate valid for one day for `127.0.0.1` in a new temp directory.
 *
 * @param {string} [prefix] - prefix of the temp directory name
 * @returns {{ dir: string, key: string, cert: string, remove: () => void }} the PEM contents
 *   of the key and certificate, and a function that deletes the directory
 * @throws {Error} when `openssl` fails
 */
export function createSelfSignedCertificate(prefix = 'ihub-tls-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const made = spawnSync('openssl', [
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
