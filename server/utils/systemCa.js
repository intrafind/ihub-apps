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

/** Why the setting says to leave the store alone, or null. */
function settingSkipReason(env) {
  const setting = String(env.NODE_USE_SYSTEM_CA ?? '')
    .trim()
    .toLowerCase();
  if (OFF_VALUES.has(setting)) return 'disabled';
  return setting === '1' ? 'node-managed' : null;
}

/** True when Node was started with a flag that already picks the CA store. */
function hasExplicitCaFlag(env, execArgv) {
  const args = [...execArgv, ...String(env.NODE_OPTIONS ?? '').split(/\s+/)];
  return CA_FLAGS.some(flag => args.includes(flag));
}

function addSystemRoots(tlsModule) {
  try {
    const system = tlsModule.getCACertificates('system');
    if (!system.length) return { applied: false, reason: 'no-system-certificates' };
    tlsModule.setDefaultCACertificates([...tlsModule.getCACertificates('default'), ...system]);
    return { applied: true, reason: 'applied', count: system.length };
  } catch (error) {
    return { applied: false, reason: `error: ${error.message}` };
  }
}

const defaultDeps = () => ({ env: process.env, execArgv: process.execArgv, tlsModule: tls });

/**
 * @param {{ env: Object, execArgv: string[], tlsModule: Object }} [deps] - Injected for tests
 * @returns {{ applied: boolean, reason: string, count?: number }}
 */
export function applySystemCaDefault({ env, execArgv, tlsModule } = defaultDeps()) {
  if (typeof tlsModule.setDefaultCACertificates !== 'function') {
    return { applied: false, reason: 'unsupported-node' };
  }
  const skip =
    settingSkipReason(env) ?? (hasExplicitCaFlag(env, execArgv) ? 'explicit-ca-flag' : null);
  return skip ? { applied: false, reason: skip } : addSystemRoots(tlsModule);
}
