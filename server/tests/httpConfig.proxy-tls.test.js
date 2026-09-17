/**
 * Regression test for `TlsForwardingHttpsProxyAgent` in server/utils/httpConfig.js.
 *
 * The subclass exists to work around a bug in `https-proxy-agent` >=7.0.0 (verified
 * through 9.0.0) where constructor `rejectUnauthorized` does not reach the destination
 * TLS handshake — only the proxy connection itself. This test pins the contract that our
 * subclass injects `rejectUnauthorized` into the `opts` argument of `connect()`, which is
 * what the parent `connect()` spreads into `tls.connect()` for the destination upgrade.
 *
 * Asserting on the `opts` passed to `super.connect()` catches the regression case where
 * a future upgrade either fixes the upstream bug (making our injection redundant but still
 * correct) or changes the `connect()` signature in a way that breaks our injection.
 */

import { describe, expect, jest, test, beforeEach, afterEach } from '@jest/globals';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { TlsForwardingHttpsProxyAgent } from '../utils/httpConfig.js';

describe('TlsForwardingHttpsProxyAgent', () => {
  let connectSpy;

  beforeEach(() => {
    connectSpy = jest
      .spyOn(HttpsProxyAgent.prototype, 'connect')
      .mockImplementation(async () => ({}));
  });

  afterEach(() => {
    connectSpy.mockRestore();
  });

  test('injects rejectUnauthorized: false into destination connect opts', async () => {
    const agent = new TlsForwardingHttpsProxyAgent('http://proxy.example:8080', {
      rejectUnauthorized: false
    });
    const incomingOpts = { host: 'destination.example', port: 443, secureEndpoint: true };

    await agent.connect({}, incomingOpts);

    expect(connectSpy).toHaveBeenCalledTimes(1);
    const forwardedOpts = connectSpy.mock.calls[0][1];
    expect(forwardedOpts).toMatchObject({
      host: 'destination.example',
      port: 443,
      secureEndpoint: true,
      rejectUnauthorized: false
    });
  });

  test('preserves rejectUnauthorized: true when explicitly provided', async () => {
    const agent = new TlsForwardingHttpsProxyAgent('http://proxy.example:8080', {
      rejectUnauthorized: true
    });

    await agent.connect({}, { host: 'd', port: 443, secureEndpoint: true });

    const forwardedOpts = connectSpy.mock.calls[0][1];
    expect(forwardedOpts.rejectUnauthorized).toBe(true);
  });

  test('does not inject rejectUnauthorized when ctor opts omit it', async () => {
    const agent = new TlsForwardingHttpsProxyAgent('http://proxy.example:8080');

    await agent.connect({}, { host: 'd', port: 443, secureEndpoint: true });

    const forwardedOpts = connectSpy.mock.calls[0][1];
    expect(Object.prototype.hasOwnProperty.call(forwardedOpts, 'rejectUnauthorized')).toBe(false);
  });

  test('does not mutate the caller-supplied opts object', async () => {
    const agent = new TlsForwardingHttpsProxyAgent('http://proxy.example:8080', {
      rejectUnauthorized: false
    });
    const incomingOpts = { host: 'd', port: 443, secureEndpoint: true };

    await agent.connect({}, incomingOpts);

    expect(Object.prototype.hasOwnProperty.call(incomingOpts, 'rejectUnauthorized')).toBe(false);
  });
});
