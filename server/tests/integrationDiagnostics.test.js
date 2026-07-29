/**
 * Tests for the diagnostics helpers behind the admin iFinder / iAssistant
 * connection tests.
 *
 * The cases pin the checks that exist because of real support pain:
 *   - a single-label hostname passes locally but is unresolvable for iFinder,
 *     which is what produced a 500 from iFinder ("could not resolve the name");
 *   - a 401 with an empty body has to yield the claims and the trust settings
 *     to compare, not just "failed";
 *   - the raw JWT must never leak into the parts of the result that are meant
 *     to be shareable.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {
  DiagnosticsReport,
  STATUS,
  buildCurlCommand,
  decodeJwt,
  describeHttpFailure,
  describeNetworkError,
  inspectUrl,
  isCertificateError,
  isPrivateAddress,
  previewToken,
  probeTcpTls,
  redactHeaders,
  resolveHostname,
  truncateBody
} from '../services/integrations/integrationDiagnostics.js';

describe('inspectUrl', () => {
  it('accepts a plain https FQDN without complaints', () => {
    const result = inspectUrl('https://ifinder.example.com');
    assert.equal(result.valid, true);
    assert.equal(result.hostname, 'ifinder.example.com');
    assert.equal(result.port, 443);
    assert.equal(result.isFqdn, true);
    assert.deepEqual(result.warnings, []);
  });

  it('keeps an explicit port and reports it as explicit', () => {
    const result = inspectUrl('https://ifinder.example.com:8443/base');
    assert.equal(result.port, 8443);
    assert.equal(result.defaultPort, false);
    assert.equal(result.pathname, '/base');
  });

  it('warns about a single-label hostname', () => {
    const result = inspectUrl('https://ifinder');
    assert.equal(result.valid, true);
    assert.equal(result.isFqdn, false);
    assert.match(result.warnings.join(' '), /single-label/);
  });

  it('rejects a single-label hostname for a URL another host must call', () => {
    const result = inspectUrl('https://ifinder', { remoteCallback: true });
    assert.equal(result.valid, false);
    assert.match(result.errors.join(' '), /fully qualified domain name/);
  });

  it('rejects localhost as a remote callback URL', () => {
    const result = inspectUrl('http://localhost:3000', { remoteCallback: true });
    assert.equal(result.valid, false);
    assert.match(result.errors.join(' '), /localhost/);
  });

  it('accepts localhost for a local URL but flags it', () => {
    const result = inspectUrl('http://localhost:3000');
    assert.equal(result.valid, true);
    assert.match(result.warnings.join(' '), /localhost/);
  });

  it('warns about plaintext http to a remote host', () => {
    const result = inspectUrl('http://ifinder.example.com');
    assert.match(result.warnings.join(' '), /unencrypted/);
  });

  it('flags surrounding whitespace from copy & paste', () => {
    const result = inspectUrl('  https://ifinder.example.com  ');
    assert.equal(result.valid, true);
    assert.equal(result.hostname, 'ifinder.example.com');
    assert.match(result.warnings.join(' '), /whitespace/);
  });

  it('reports a missing scheme as invalid instead of guessing one', () => {
    const result = inspectUrl('ifinder.example.com');
    assert.equal(result.valid, false);
    assert.match(result.errors.join(' '), /not a valid absolute URL/);
  });

  it('reports an empty URL', () => {
    assert.equal(inspectUrl('').valid, false);
    assert.equal(inspectUrl(undefined).valid, false);
  });

  it('treats an IP literal as resolvable and not short', () => {
    const result = inspectUrl('https://10.1.2.3:8443');
    assert.equal(result.isIpLiteral, true);
    assert.equal(result.isFqdn, false);
    assert.equal(result.isPrivate, true);
    assert.equal(result.valid, true);
  });
});

describe('isPrivateAddress', () => {
  it('detects RFC1918 and link-local ranges', () => {
    for (const address of [
      '10.0.0.1',
      '192.168.1.1',
      '172.16.0.1',
      '172.31.255.255',
      '169.254.1.1'
    ]) {
      assert.equal(isPrivateAddress(address), true, address);
    }
  });

  it('does not flag public addresses or the 172.32 boundary', () => {
    for (const address of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '11.0.0.1']) {
      assert.equal(isPrivateAddress(address), false, address);
    }
  });
});

describe('resolveHostname', () => {
  it('short-circuits IP literals without a lookup', async () => {
    const result = await resolveHostname('127.0.0.1');
    assert.equal(result.resolved, true);
    assert.equal(result.literal, true);
    assert.equal(result.addresses[0].address, '127.0.0.1');
  });

  it('reports an unresolvable hostname instead of throwing', async () => {
    const result = await resolveHostname('nonexistent-host.invalid');
    assert.equal(result.resolved, false);
    assert.ok(result.code, 'expected a DNS error code');
  });
});

describe('decodeJwt', () => {
  const secret = 'test-secret';

  it('exposes the claims an admin has to compare with iFinder', () => {
    const token = jwt.sign({ sub: 'user@example.com', scope: 'fa_index_read' }, secret, {
      algorithm: 'HS256',
      issuer: 'https://ihub.example.com',
      audience: 'ifinder-api',
      expiresIn: 3600,
      keyid: 'abc123'
    });

    const info = decodeJwt(token);
    assert.equal(info.decoded, true);
    assert.equal(info.subject, 'user@example.com');
    assert.equal(info.issuer, 'https://ihub.example.com');
    assert.equal(info.audience, 'ifinder-api');
    assert.equal(info.scope, 'fa_index_read');
    assert.equal(info.algorithm, 'HS256');
    assert.equal(info.keyId, 'abc123');
    assert.equal(info.lifetimeSeconds, 3600);
    assert.match(info.issuedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(info.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('does not throw on a malformed token', () => {
    const info = decodeJwt('not-a-jwt');
    assert.equal(info.decoded, false);
    assert.ok(info.error);
  });
});

describe('token and header redaction', () => {
  it('previews a token without exposing the signature', () => {
    const token = `${'a'.repeat(40)}.${'b'.repeat(40)}.${'c'.repeat(40)}`;
    const preview = previewToken(token);
    assert.ok(preview.includes('…'));
    assert.ok(!preview.includes('c'.repeat(20)));
    assert.match(preview, /122 chars/);
  });

  it('replaces the Authorization credential but keeps other headers', () => {
    const redacted = redactHeaders({
      Authorization: 'Bearer header.payload.signature',
      Accept: 'application/json'
    });
    assert.equal(redacted.Authorization, 'Bearer <jwt>');
    assert.equal(redacted.Accept, 'application/json');
  });

  it('truncates an oversized body and says so', () => {
    const truncated = truncateBody('x'.repeat(5000), 100);
    assert.equal(truncated.startsWith('x'.repeat(100)), true);
    assert.match(truncated, /truncated, 5000 chars total/);
    assert.equal(truncateBody('short', 100), 'short');
  });
});

describe('buildCurlCommand', () => {
  it('uses a $TOKEN placeholder when the token is withheld', () => {
    const command = buildCurlCommand({
      url: 'https://ifinder.example.com/search?query=test',
      headers: { Authorization: 'Bearer secret.jwt.value', Accept: 'application/json' }
    });
    assert.ok(!command.includes('secret.jwt.value'));
    assert.match(command, /Authorization: Bearer \$TOKEN/);
    assert.match(command, /'Accept: application\/json'/);
  });

  it('inlines the token when it was explicitly requested', () => {
    const command = buildCurlCommand({
      url: 'https://ifinder.example.com/search',
      token: 'secret.jwt.value'
    });
    assert.match(command, /Authorization: Bearer secret\.jwt\.value/);
  });

  it('escapes single quotes so the command stays one argument', () => {
    const command = buildCurlCommand({ url: "https://example.com/?q=it's" });
    assert.ok(command.includes(`'\\''`));
  });

  it('includes method and body for write requests', () => {
    const command = buildCurlCommand({
      url: 'https://example.com/conversations',
      method: 'POST',
      body: '{"a":1}'
    });
    assert.match(command, /-X POST/);
    assert.match(command, /--data-raw '\{"a":1\}'/);
  });
});

describe('describeNetworkError', () => {
  it('points at DNS for ENOTFOUND', () => {
    const hints = describeNetworkError(
      { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND x' },
      {
        hostname: 'ifinder'
      }
    );
    assert.match(hints.join(' '), /DNS lookup for "ifinder" failed/);
    assert.match(hints.join(' '), /fully qualified domain name/);
  });

  it('points at the port for ECONNREFUSED', () => {
    const hints = describeNetworkError(
      { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' },
      {
        hostname: 'ifinder.example.com',
        port: 8443
      }
    );
    assert.match(hints.join(' '), /Nothing is listening on ifinder\.example\.com:8443/);
  });

  it('points at firewalls and proxies for a timeout', () => {
    const hints = describeNetworkError(
      { code: 'ETIMEDOUT', message: 'timeout' },
      {
        hostname: 'h',
        port: 443,
        timeout: 30000
      }
    );
    assert.match(hints.join(' '), /firewall/);
    assert.match(hints.join(' '), /30000ms/);
  });

  it('points at the trust store for certificate errors', () => {
    const hints = describeNetworkError({ message: 'self signed certificate in chain' });
    assert.match(hints.join(' '), /trust store/);
  });

  it('always mentions the server log', () => {
    const hints = describeNetworkError({ code: 'EUNKNOWN', message: 'boom' });
    assert.match(hints.join(' '), /server log/);
  });
});

describe('describeHttpFailure', () => {
  const jwtInfo = {
    subject: 'user@example.com',
    issuer: 'https://ihub.example.com',
    audience: 'ifinder-api',
    algorithm: 'RS256',
    keyId: 'abc123',
    scope: 'fa_index_read'
  };

  it('turns a bare 401 into the claims and settings to compare', () => {
    const hints = describeHttpFailure({
      status: 401,
      body: '',
      headers: {},
      jwt: jwtInfo,
      context: { useOidcKeyPair: true, jwksUrl: 'https://ihub.example.com/.well-known/jwks.json' }
    });
    const text = hints.join(' ');
    assert.match(text, /sub="user@example\.com"/);
    assert.match(text, /iss="https:\/\/ihub\.example\.com"/);
    assert.match(text, /kid="abc123"/);
    assert.match(text, /jwks\.json/);
    assert.match(text, /JWT Subject Field/);
    assert.match(text, /clock/);
  });

  it('surfaces the WWW-Authenticate header when the server sent one', () => {
    const hints = describeHttpFailure({
      status: 401,
      headers: { 'www-authenticate': 'Bearer error="invalid_token"' },
      jwt: jwtInfo
    });
    assert.match(hints.join(' '), /invalid_token/);
  });

  it('mentions the deployed public key in private key mode', () => {
    const hints = describeHttpFailure({
      status: 401,
      jwt: jwtInfo,
      context: { useOidcKeyPair: false }
    });
    assert.match(hints.join(' '), /public key deployed in iFinder/);
    assert.ok(!hints.join(' ').includes('JWKS'));
  });

  it('blames scope and permissions for a 403', () => {
    const hints = describeHttpFailure({ status: 403, jwt: jwtInfo });
    assert.match(hints.join(' '), /fa_index_read/);
    assert.match(hints.join(' '), /search profile/);
  });

  it('warns about a doubled API path for a 404', () => {
    const hints = describeHttpFailure({
      status: 404,
      jwt: jwtInfo,
      context: { searchProfile: 'searchprofile-standard' }
    });
    assert.match(hints.join(' '), /\/public-api/);
    assert.match(hints.join(' '), /searchprofile-standard/);
  });

  it('explains a 500 as a remote-side failure and names the JWKS callback', () => {
    const hints = describeHttpFailure({
      status: 500,
      jwt: jwtInfo,
      context: { jwksUrl: 'https://ihub.example.com/.well-known/jwks.json' }
    });
    const text = hints.join(' ');
    assert.match(text, /answered with a server error/);
    assert.match(text, /cannot resolve or reach the JWKS/);
    assert.match(text, /Short hostname|short hostname/);
  });

  it('detects an HTML error page from a proxy', () => {
    const hints = describeHttpFailure({ status: 502, body: '<!DOCTYPE html><html>...' });
    assert.match(hints.join(' '), /HTML, not JSON/);
  });
});

describe('DiagnosticsReport', () => {
  it('records steps in order with durations and a status summary', async () => {
    const report = new DiagnosticsReport();
    report.add({ id: 'a', label: 'A', status: STATUS.OK, message: 'fine' });
    await report.run('b', 'B', () => ({ status: STATUS.WARN, message: 'hmm', hints: ['look'] }));
    report.skip('c', 'C', 'not applicable');

    assert.deepEqual(
      report.steps.map(step => step.id),
      ['a', 'b', 'c']
    );
    assert.equal(typeof report.steps[1].durationMs, 'number');
    assert.deepEqual(report.steps[1].hints, ['look']);
    assert.equal(report.hasFailure(), false);

    const summary = report.summary();
    assert.equal(summary.ok, 1);
    assert.equal(summary.warn, 1);
    assert.equal(summary.skip, 1);
    assert.equal(summary.total, 3);
  });

  it('converts a thrown error into a failed step and keeps going', async () => {
    const report = new DiagnosticsReport();
    await report.run('boom', 'Boom', () => {
      const error = new Error('exploded');
      error.code = 'EBOOM';
      throw error;
    });
    await report.run('after', 'After', () => ({ status: STATUS.OK }));

    assert.equal(report.steps[0].status, STATUS.FAIL);
    assert.equal(report.steps[0].message, 'exploded');
    assert.equal(report.steps[0].details.code, 'EBOOM');
    assert.equal(report.steps[1].status, STATUS.OK);
    assert.equal(report.hasFailure(), true);
  });

  it('omits empty details and hints so the UI has nothing to expand', () => {
    const report = new DiagnosticsReport();
    report.add({ id: 'a', label: 'A', status: STATUS.OK, details: {}, hints: [] });
    assert.equal('details' in report.steps[0], false);
    assert.equal('hints' in report.steps[0], false);
  });

  it('deduplicates hints, keeping first-seen order', () => {
    const report = new DiagnosticsReport();
    report.add({
      id: 'a',
      label: 'A',
      status: STATUS.FAIL,
      hints: ['check DNS', 'check the server log', 'check DNS']
    });
    assert.deepEqual(report.steps[0].hints, ['check DNS', 'check the server log']);
  });
});

describe('isCertificateError', () => {
  it('recognises OpenSSL verification failures by code', () => {
    for (const code of [
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'CERT_HAS_EXPIRED',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'ERR_TLS_CERT_ALTNAME_INVALID'
    ]) {
      assert.equal(isCertificateError({ code, message: '' }), true, code);
    }
  });

  it('recognises them by message when no code is present', () => {
    assert.equal(isCertificateError({ message: 'self signed certificate in chain' }), true);
    assert.equal(
      isCertificateError({ message: "Hostname/IP does not match certificate's altnames" }),
      true
    );
  });

  it('does not classify transport failures as certificate failures', () => {
    for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH']) {
      assert.equal(isCertificateError({ code, message: 'connect failed' }), false, code);
    }
    assert.equal(isCertificateError(null), false);
    assert.equal(isCertificateError(undefined), false);
  });
});

describe('probeTcpTls certificate validation', () => {
  it('always enforces certificate verification, with no way to relax it', () => {
    // An external badssl-style host is not reachable from every CI network, so
    // this pins the contract that can be checked offline: verification is
    // hardcoded on, and there is no parameter a caller could use to turn it off.
    const source = probeTcpTls.toString();
    assert.match(source, /rejectUnauthorized:\s*true/);
    assert.ok(
      !/rejectUnauthorized:\s*false/.test(source),
      'probeTcpTls must never set rejectUnauthorized: false'
    );
    assert.ok(
      !/rejectUnauthorized\s*=/.test(source),
      'probeTcpTls must not accept rejectUnauthorized as a caller-supplied option'
    );
  });

  it('reports a refused port as unreachable, not as a certificate problem', async () => {
    // Port 1 is reserved and never listening.
    const probe = await probeTcpTls({
      hostname: '127.0.0.1',
      port: 1,
      protocol: 'http',
      timeout: 3000
    });
    assert.equal(probe.connected, false);
    assert.equal(probe.certificateRejected, false);
    assert.ok(probe.code);
  });
});
