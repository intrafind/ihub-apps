// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import net from 'node:net';
import tls from 'node:tls';
import { Client, SearchRequest } from 'ldapts';
import configCache from '../../configCache.js';
import credentialService from '../CredentialService.js';
import { guardedLookup } from '../../utils/dnsGuard.js';
import { isPrivateIP } from '../../utils/ssrfGuard.js';
import { getTlsBypassOptions } from '../../utils/httpConfig.js';
import { buildStartTlsOptions } from '../../utils/ldapProviderConfig.js';
import { hostMatchesPattern } from '../mcp/safeFetch.js';
import { ALLOWED_TLS_OPTION_KEYS } from '../../validators/peopleDirectorySchema.js';
import { loadTrustAnchors } from './certStore.js';
import {
  DirectoryConnectionError,
  assertTransportAllowed,
  describeTransport,
  parseDirectoryUrl
} from './transport.js';

export { DirectoryConnectionError, assertTransportAllowed, describeTransport, parseDirectoryUrl };

/**
 * Opening a connection to a people directory.
 *
 * The directory URL can come from an admin, an inherited sign-in provider or
 * an unsaved test entry, so every connection is checked like any other
 * outbound request (REVIEW.md, A01), at connection time:
 *
 * 1. **Transport.** LDAPS or StartTLS unless the directory sets
 *    `allowPlaintext`; search terms and the records that come back are
 *    personal data. A service bind is never sent in plain text.
 * 2. **Target.** The host is resolved through the DNS guard and every address
 *    is classified. A private, loopback or link-local address is refused unless
 *    the host is allowed explicitly: the directory's `allowedHosts`, the
 *    platform's `ssrf.allowedHosts`, or the host of the referenced sign-in
 *    provider, which iHub already connects to on every login.
 * 3. **Pinning.** The socket connects to the validated address, never to the
 *    name again, so a DNS change between check and connect cannot redirect it.
 *    TLS still verifies the certificate against the host name.
 * 4. **TLS options**, built in a fixed order so nothing configurable can turn
 *    verification off: the allowed `tlsOptions` keys, `ca` from `tlsCa`,
 *    `servername`/`host` (the host name), then `getTlsBypassOptions(url)` — the
 *    only source of `rejectUnauthorized: false`, and only for a host on the
 *    SSL whitelist. The same object serves `ldaps://` and StartTLS.
 *
 * LDAP is not HTTP: the platform proxy does not apply, so external directories
 * need a direct route on port 389/636.
 */

/**
 * An ldapts client that remembers the result code of its last search.
 *
 * ldapts accepts result code 4 (size limit exceeded) as a successful search
 * when the request carried a size limit, and does not say that it happened. A
 * public directory whose own limit is below the one sent would then look like
 * a complete answer; with the code recorded, the search reports a partial
 * result instead.
 */
export class DirectoryClient extends Client {
  constructor(options) {
    super(options);
    this.lastSearchResultCode = null;
  }

  async _send(message) {
    const result = await super._send(message);
    if (message instanceof SearchRequest) this.lastSearchResultCode = result?.status ?? null;
    return result;
  }
}

/** Whether an error is ldapts' or the socket's timeout. */
export function isTimeoutError(error) {
  return error?.code === 'ETIMEDOUT' || /timed out|timeout/i.test(error?.message || '');
}

/**
 * Why a host may resolve to a private address, or null when it may not.
 * @param {string} hostname
 * @param {Object} resolved
 * @param {Object} [platform]
 * @returns {'allowedHosts'|'ssrf.allowedHosts'|'authProvider'|null}
 */
export function privateTargetAllowance(hostname, resolved, platform = configCache.getPlatform()) {
  if ((resolved.allowedHosts || []).some(pattern => hostMatchesPattern(hostname, pattern))) {
    return 'allowedHosts';
  }
  const platformHosts = platform?.ssrf?.allowedHosts;
  if (
    Array.isArray(platformHosts) &&
    platformHosts.some(pattern => hostMatchesPattern(hostname, pattern))
  ) {
    return 'ssrf.allowedHosts';
  }
  if (resolved.providerHost && resolved.providerHost.toLowerCase() === hostname.toLowerCase()) {
    return 'authProvider';
  }
  return null;
}

/**
 * Resolve a host through the DNS guard (de-duplicated, bounded wait).
 * @param {Function} lookup - `dns.lookup`-compatible function
 * @param {string} hostname
 * @returns {Promise<string[]>}
 */
function lookupAll(lookup, hostname) {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: true }, (error, addresses) => {
      if (error) return reject(error);
      resolve((addresses || []).map(entry => (typeof entry === 'string' ? entry : entry.address)));
    });
  });
}

/**
 * The SSRF check: resolve the host and classify every address.
 *
 * @param {string} hostname
 * @param {Object} resolved - Resolved directory
 * @param {Object} [options]
 * @param {Function} [options.lookup] - Resolver (the DNS guard by default)
 * @returns {Promise<{addresses: string[], pinnedAddress: string, privateAddresses: string[], allowedBy: string|null}>}
 * @throws {DirectoryConnectionError}
 */
export async function resolveTarget(hostname, resolved, { lookup = guardedLookup } = {}) {
  if (/[\u0000-\u001f\u007f]/.test(hostname)) {
    throw new DirectoryConnectionError('The host name contains control characters.', {
      code: 'ssrf_blocked',
      step: 'network'
    });
  }

  let addresses;
  if (net.isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = await lookupAll(lookup, hostname);
    } catch (error) {
      throw new DirectoryConnectionError(
        `The host name ${hostname} does not resolve from this server: ${error.message}`,
        { code: 'dns_failed', step: 'network', cause: error }
      );
    }
  }
  if (addresses.length === 0) {
    throw new DirectoryConnectionError(`The host name ${hostname} resolved to no address.`, {
      code: 'dns_failed',
      step: 'network'
    });
  }

  const lowerHost = hostname.toLowerCase();
  const isLocalName = lowerHost === 'localhost' || lowerHost.endsWith('.localhost');
  const privateAddresses = addresses.filter(address => isLocalName || isPrivateIP(address));
  const allowedBy = privateAddresses.length > 0 ? privateTargetAllowance(hostname, resolved) : null;
  if (privateAddresses.length > 0 && !allowedBy) {
    throw new DirectoryConnectionError(
      `${hostname} resolves to the private address ${privateAddresses[0]}. Internal directories need an explicit allow-list entry.`,
      {
        code: 'ssrf_blocked',
        step: 'network',
        details: { host: hostname, addresses },
        hints: [
          `Add "${hostname}" to the directory's allowed hosts, or to the platform-wide SSRF allow-list (Admin → Security), or reuse the sign-in provider that already connects to it.`
        ]
      }
    );
  }
  return { addresses, pinnedAddress: addresses[0], privateAddresses, allowedBy };
}

/**
 * The TLS options of a directory connection, in the fixed order described above.
 *
 * @param {Object} resolved - Resolved directory (`tlsOptions` already reduced to the allowed keys)
 * @param {string[]} [anchors] - PEM trust anchors from `tlsCa`
 * @returns {Object}
 */
export function buildDirectoryTlsOptions(resolved, anchors = []) {
  const allowed = {};
  for (const key of ALLOWED_TLS_OPTION_KEYS) {
    if (resolved.tlsOptions?.[key] !== undefined) allowed[key] = resolved.tlsOptions[key];
  }
  return {
    ...allowed,
    ...(anchors.length > 0 && { ca: anchors }),
    // `host` and, for a DNS name, `servername`: the certificate is checked
    // against the host name, never against the pinned address.
    ...buildStartTlsOptions(resolved.url),
    ...getTlsBypassOptions(resolved.url)
  };
}

/**
 * The certificates a TLS socket was presented, leaf first.
 * @param {tls.TLSSocket} socket
 * @returns {Array<Object>}
 */
function readPresentedChain(socket) {
  const chain = [];
  const seen = new Set();
  let cert = socket.getPeerCertificate?.(true);
  while (cert && cert.raw && !seen.has(cert.fingerprint256)) {
    seen.add(cert.fingerprint256);
    chain.push({
      subject: cert.subject?.CN || formatName(cert.subject),
      issuer: cert.issuer?.CN || formatName(cert.issuer),
      validFrom: cert.valid_from,
      validTo: cert.valid_to,
      fingerprint256: cert.fingerprint256,
      raw: cert.raw
    });
    cert = cert.issuerCertificate;
  }
  return chain;
}

function formatName(name) {
  return name
    ? Object.entries(name)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ')
    : '';
}

/**
 * Explain a certificate verification failure from the chain the server sent:
 * which issuer this server does not trust.
 *
 * @param {Array<Object>} chain - From the connection, leaf first
 * @returns {{certificateChain: Array<Object>, missingIssuer: string|null}}
 */
export function explainCertificateFailure(chain) {
  // eslint-disable-next-line no-unused-vars
  const presented = chain.map(({ raw, ...rest }) => rest);
  if (chain.length === 0) return { certificateChain: presented, missingIssuer: null };
  const last = chain[chain.length - 1];
  // The chain ends with the topmost certificate the server sent: a root when
  // it is self-issued, otherwise its issuer is the one missing here.
  const missingIssuer = last.subject === last.issuer ? last.subject : last.issuer;
  return { certificateChain: presented, missingIssuer };
}

const CERTIFICATE_ERROR_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_SIGNATURE_FAILURE',
  'ERR_TLS_CERT_ALTNAME_INVALID'
]);

/** Codes that mean the chain does not end in a trusted root. */
const UNTRUSTED_ISSUER_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_UNTRUSTED'
]);

/**
 * Turn a socket/TLS/LDAP error from the connection phase into a
 * {@link DirectoryConnectionError}.
 */
function classifyConnectionError(error, { step, hostname, port, state }) {
  if (error instanceof DirectoryConnectionError) return error;
  const code = error?.code;
  if (CERTIFICATE_ERROR_CODES.has(code)) {
    const explained = explainCertificateFailure(state.chain);
    const { certificateChain } = explained;
    const missingIssuer = UNTRUSTED_ISSUER_CODES.has(code) ? explained.missingIssuer : null;
    const hostnameMismatch = code === 'ERR_TLS_CERT_ALTNAME_INVALID';
    const message = hostnameMismatch
      ? `The certificate of ${hostname} does not name that host: ${error.message}`
      : missingIssuer
        ? `The certificate of ${hostname} is not trusted: issuer "${missingIssuer}" is not trusted (${code}). Add it to the certificate store and to this directory's trust anchors (tlsCa).`
        : `The certificate of ${hostname} was rejected (${code}): ${error.message}`;
    return new DirectoryConnectionError(message, {
      code: hostnameMismatch ? 'tls_hostname' : 'tls_untrusted',
      step,
      cause: error,
      details: { host: hostname, port, errorCode: code, missingIssuer, certificateChain },
      hints: hostnameMismatch
        ? ['Use the host name the certificate was issued for in the directory URL.']
        : !missingIssuer
          ? [
              'Check the validity dates of the certificates below, and the clock of the iHub server.'
            ]
          : [
              'iHub never fetches or trusts a root by itself. Download the issuing root from its publisher, compare the fingerprint with the published one, upload it under Certificates and select it as a trust anchor of this directory.'
            ]
    });
  }
  if (code === 'ECONNREFUSED') {
    return new DirectoryConnectionError(
      `Nothing accepts connections on ${hostname}:${port}. Check the port (636 for ldaps://, 389 for ldap://).`,
      { code: 'connection_refused', step, cause: error }
    );
  }
  if (isTimeoutError(error)) {
    return new DirectoryConnectionError(
      `${hostname}:${port} did not answer in time. LDAP does not use the HTTP proxy: the iHub server needs a direct route to the directory.`,
      { code: 'timeout', step, cause: error }
    );
  }
  return new DirectoryConnectionError(
    `Could not connect to ${hostname}:${port}: ${error?.message || error}`,
    { code: 'connection_failed', step, cause: error }
  );
}

/**
 * Open a connection to a directory: transport check, SSRF check with a pinned
 * address, TLS (ldaps:// or StartTLS) and bind. The caller searches and must
 * `unbind()` the returned client in `finally`.
 *
 * @param {Object} resolved - Resolved directory (`PeopleDirectoryService.resolveDirectory`)
 * @param {Object} [options]
 * @param {Function} [options.lookup] - Resolver for the SSRF check
 * @param {(options: Object) => Client} [options.createClient] - ldapts client factory (tests)
 * @param {(step: Object) => void} [options.onStep] - Receives each successful step (admin test)
 * @param {(names: string[]) => Promise<string[]>} [options.loadAnchors] - Trust anchor loader (tests)
 * @returns {Promise<{client: Client, info: Object}>}
 * @throws {DirectoryConnectionError}
 */
export async function openDirectoryConnection(
  resolved,
  {
    lookup = guardedLookup,
    createClient = options => new DirectoryClient(options),
    onStep = () => {},
    loadAnchors = loadTrustAnchors
  } = {}
) {
  assertTransportAllowed(resolved);
  const { hostname, port, secure, protocol } = parseDirectoryUrl(resolved.url);
  const transport = describeTransport(resolved);

  let startedAt = Date.now();
  const target = await resolveTarget(hostname, resolved, { lookup });
  onStep({
    id: 'network',
    message: target.allowedBy
      ? `${hostname} resolves to ${target.addresses.join(', ')}; private address allowed by ${target.allowedBy}`
      : `${hostname} resolves to ${target.addresses.join(', ')}`,
    details: {
      host: hostname,
      addresses: target.addresses,
      pinnedAddress: target.pinnedAddress,
      allowedBy: target.allowedBy
    },
    durationMs: Date.now() - startedAt
  });

  let anchors;
  try {
    anchors = await loadAnchors(resolved.tlsCa || []);
  } catch (error) {
    throw new DirectoryConnectionError(error.message, {
      code: 'trust_anchor_missing',
      step: 'connect',
      cause: error
    });
  }

  const tlsOptions = buildDirectoryTlsOptions(resolved, anchors);
  const pinned = target.pinnedAddress;
  const pinnedHost = net.isIP(pinned) === 6 ? `[${pinned}]` : pinned;
  const state = { socketConnected: false, chain: [], tls: null };

  const watchTls = socket => {
    // Runs before Node's own verification step, so the presented chain is
    // known even when verification then fails — without ever turning it off.
    socket.prependOnceListener('secure', () => {
      state.chain = readPresentedChain(socket);
    });
    socket.once('secureConnect', () => {
      state.tls = {
        protocol: socket.getProtocol?.() || null,
        cipher: socket.getCipher?.()?.name || null,
        authorized: socket.authorized
      };
    });
    return socket;
  };

  const client = createClient({
    url: `${protocol}//${pinnedHost}:${port}`,
    timeout: resolved.timeoutMs,
    connectTimeout: resolved.timeoutMs,
    // ldapts treats a client with any TLS options as ldaps:// (TLS from the
    // first byte), so for StartTLS they go to `startTLS()` only.
    ...(secure && { tlsOptions }),
    createConnection: connectPort => {
      const socket = net.connect({ port: connectPort, host: pinned });
      socket.once('connect', () => {
        state.socketConnected = true;
      });
      return socket;
    },
    createSecureConnection: (portOrOptions, _host, options) => {
      if (typeof portOrOptions === 'object') {
        // StartTLS: upgrades the open (pinned) socket in `options.socket`.
        return watchTls(tls.connect(portOrOptions));
      }
      // ldaps://: dial the pinned address; `servername` (the host name) is
      // what the certificate is checked against.
      const socket = watchTls(tls.connect({ ...options, port: portOrOptions, host: pinned }));
      socket.once('secureConnect', () => {
        state.socketConnected = true;
      });
      return socket;
    }
  });

  const info = {
    host: hostname,
    port,
    pinnedAddress: pinned,
    addresses: target.addresses,
    allowedBy: target.allowedBy,
    transport
  };

  const fail = (error, step) => {
    void client.unbind().catch(() => {});
    return classifyConnectionError(error, { step, hostname, port, state });
  };

  if (transport === 'starttls') {
    startedAt = Date.now();
    try {
      await client.startTLS({ ...tlsOptions });
    } catch (error) {
      throw fail(error, state.socketConnected ? 'starttls' : 'connect');
    }
    onStep({
      id: 'connect',
      message: `Connected to ${hostname}:${port} (${pinned})`,
      details: info,
      durationMs: Date.now() - startedAt
    });
    onStep({
      id: 'starttls',
      message: `StartTLS ${state.tls?.protocol || ''} ${state.tls?.cipher || ''}`.trim(),
      details: {
        ...state.tls,
        certificateChain: explainCertificateFailure(state.chain).certificateChain
      }
    });
  }

  let bindDn = '';
  let password = '';
  if (resolved.bind?.mode === 'service') {
    bindDn = resolved.bind.dn;
    try {
      password = credentialService.resolveSecret(resolved.bind.passwordRef) || '';
    } catch (error) {
      void client.unbind().catch(() => {});
      throw new DirectoryConnectionError(
        `The bind password could not be resolved: ${error.message}`,
        {
          code: 'bind_credential',
          step: 'bind',
          hints: [
            `Check that the credential profile "${resolved.bind.passwordRef}" exists under Admin → Credentials.`
          ]
        }
      );
    }
    if (!password) {
      void client.unbind().catch(() => {});
      throw new DirectoryConnectionError('The bind password credential is empty.', {
        code: 'bind_credential',
        step: 'bind'
      });
    }
  }

  // An explicit bind, anonymous when no service account is set: it opens the
  // connection for ldaps:// and plain LDAP (so a connection failure is reported
  // as one), and directories that still speak LDAPv2 expect it first.
  startedAt = Date.now();
  try {
    await client.bind(bindDn, password);
  } catch (error) {
    if (!state.socketConnected) throw fail(error, 'connect');
    if (isTimeoutError(error)) throw fail(error, 'bind');
    void client.unbind().catch(() => {});
    throw new DirectoryConnectionError(
      bindDn
        ? `The directory rejected the bind as ${bindDn}: ${error.message}`
        : `The directory rejected an anonymous bind: ${error.message}`,
      {
        code: 'bind_failed',
        step: 'bind',
        cause: error,
        hints: bindDn
          ? ['Check the bind DN and the password in the credential profile.']
          : [
              'This directory does not allow anonymous access. Configure a service account (on the directory, or on the sign-in provider it reuses).'
            ]
      }
    );
  }

  if (transport !== 'starttls') {
    onStep({
      id: 'connect',
      message: `Connected to ${hostname}:${port} (${pinned})${secure ? ` over ${state.tls?.protocol || 'TLS'}` : ', not encrypted'}`,
      details: {
        ...info,
        ...(secure && {
          tls: state.tls,
          certificateChain: explainCertificateFailure(state.chain).certificateChain
        })
      }
    });
  }
  onStep({
    id: 'bind',
    message: bindDn ? `Bound as ${bindDn}` : 'Anonymous bind',
    durationMs: Date.now() - startedAt
  });

  return { client, info: { ...info, tls: state.tls } };
}
