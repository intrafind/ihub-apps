// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Trust the operating system's certificate store by default.
 *
 * Node only trusts its bundled Mozilla roots, so an endpoint signed by a company
 * CA that is installed on the machine fails with "unable to verify the first
 * certificate". `NODE_USE_SYSTEM_CA=1` fixes that, but it is read at process
 * start (a `.env` file is too late, and a packaged binary has no launcher to set
 * it) and Node refuses to start when it is combined with `--use-openssl-ca`.
 * This does the same thing in-process: the system roots are added to the default
 * CA list, so every TLS client without an explicit `ca` (https, fetch, ws) sees
 * them. It adds to the bundled roots; it never replaces them.
 *
 * Opt out with `NODE_USE_SYSTEM_CA=0`. Left alone when Node already manages the
 * store (`NODE_USE_SYSTEM_CA=1`, `--use-system-ca`) or the operator chose the
 * OpenSSL store (`--use-openssl-ca`). Needs Node 24.5+; older runtimes keep the
 * bundled roots (set `NODE_USE_SYSTEM_CA=1` or `NODE_EXTRA_CA_CERTS` there).
 */
import tls from 'node:tls';

const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);
const CA_FLAGS = ['--use-system-ca', '--use-openssl-ca'];

/**
 * @param {Object} [deps] - Injected for tests
 * @returns {{ applied: boolean, reason: string, count?: number }}
 */
export function applySystemCaDefault({
  env = process.env,
  execArgv = process.execArgv,
  tlsModule = tls
} = {}) {
  if (typeof tlsModule.setDefaultCACertificates !== 'function') {
    return { applied: false, reason: 'unsupported-node' };
  }

  const setting = String(env.NODE_USE_SYSTEM_CA ?? '')
    .trim()
    .toLowerCase();
  if (OFF_VALUES.has(setting)) return { applied: false, reason: 'disabled' };
  if (setting === '1') return { applied: false, reason: 'node-managed' };

  const args = [...execArgv, ...String(env.NODE_OPTIONS ?? '').split(/\s+/)];
  if (CA_FLAGS.some(flag => args.includes(flag))) {
    return { applied: false, reason: 'explicit-ca-flag' };
  }

  try {
    const system = tlsModule.getCACertificates('system');
    if (!system.length) return { applied: false, reason: 'no-system-certificates' };
    tlsModule.setDefaultCACertificates([...tlsModule.getCACertificates('default'), ...system]);
    return { applied: true, reason: 'applied', count: system.length };
  } catch (error) {
    return { applied: false, reason: `error: ${error.message}` };
  }
}
