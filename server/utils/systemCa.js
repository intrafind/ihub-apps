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
 * Opt out with `NODE_USE_SYSTEM_CA=0`. Skipped when Node already trusts every
 * system root (it was started with `NODE_USE_SYSTEM_CA=1` or `--use-system-ca`)
 * or when the operator chose the OpenSSL store (`--use-openssl-ca`). Values that
 * only arrive later through `.env` are not startup settings and are ignored.
 * Needs Node 24.5+; older runtimes keep the bundled roots (set
 * `NODE_USE_SYSTEM_CA=1` or `NODE_EXTRA_CA_CERTS` there).
 */
import tls from 'node:tls';

const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);
const CA_FLAGS = ['--use-system-ca', '--use-openssl-ca'];

// NODE_OPTIONS as the process was started. Read when this module loads, which is
// before server.js runs dotenv: a NODE_OPTIONS line in .env never reached Node.
const startupNodeOptions = process.env.NODE_OPTIONS ?? '';

/** True when the user switched the default off. */
const isDisabled = env =>
  OFF_VALUES.has(
    String(env.NODE_USE_SYSTEM_CA ?? '')
      .trim()
      .toLowerCase()
  );

/** True when Node was started with a flag that already picks the CA store. */
function hasExplicitCaFlag(execArgv, nodeOptions) {
  const args = [...execArgv, ...nodeOptions.split(/\s+/)];
  return CA_FLAGS.some(flag => args.includes(flag));
}

/**
 * Add the system roots unless Node already trusts them all. Checking the list
 * instead of trusting NODE_USE_SYSTEM_CA is deliberate: a value that came from
 * .env arrives after startup, so Node never acted on it.
 */
function addSystemRoots(tlsModule) {
  try {
    const system = tlsModule.getCACertificates('system');
    if (!system.length) return { applied: false, reason: 'no-system-certificates' };
    const current = tlsModule.getCACertificates('default');
    const known = new Set(current);
    if (system.every(cert => known.has(cert))) return { applied: false, reason: 'already-trusted' };
    tlsModule.setDefaultCACertificates([...current, ...system]);
    return { applied: true, reason: 'applied', count: system.length };
  } catch (error) {
    return { applied: false, reason: `error: ${error.message}` };
  }
}

const defaultDeps = () => ({
  env: process.env,
  execArgv: process.execArgv,
  nodeOptions: startupNodeOptions,
  tlsModule: tls
});

/**
 * @param {{ env: Object, execArgv: string[], nodeOptions: string, tlsModule: Object }} [deps]
 *   Injected for tests
 * @returns {{ applied: boolean, reason: string, count?: number }}
 */
export function applySystemCaDefault({ env, execArgv, nodeOptions, tlsModule } = defaultDeps()) {
  if (typeof tlsModule.setDefaultCACertificates !== 'function') {
    return { applied: false, reason: 'unsupported-node' };
  }
  if (isDisabled(env)) return { applied: false, reason: 'disabled' };
  if (hasExplicitCaFlag(execArgv, nodeOptions)) {
    return { applied: false, reason: 'explicit-ca-flag' };
  }
  return addSystemRoots(tlsModule);
}
