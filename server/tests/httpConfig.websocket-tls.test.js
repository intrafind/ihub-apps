// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `getWebSocketTlsOptions` applies the ssl.domainWhitelist to outbound `wss://`
 * connections (realtime transcription), which do not go through `createAgent()`.
 */

import { describe, expect, test } from '@jest/globals';
import { getWebSocketTlsOptions } from '../utils/httpConfig.js';

const ssl = (ignoreInvalidCertificates, domainWhitelist = []) => ({
  ignoreInvalidCertificates,
  domainWhitelist
});

describe('getWebSocketTlsOptions', () => {
  test('disables verification for a whitelisted wss host', () => {
    expect(
      getWebSocketTlsOptions(
        'wss://voxtral.internal.example/v1/realtime',
        ssl(true, ['voxtral.internal.example'])
      )
    ).toEqual({ rejectUnauthorized: false });
  });

  test('supports wildcard whitelist entries', () => {
    expect(
      getWebSocketTlsOptions(
        'wss://gpu1.internal.example:8443/v1/realtime',
        ssl(true, ['*.internal.example'])
      )
    ).toEqual({ rejectUnauthorized: false });
  });

  test('keeps verification for hosts that are not whitelisted', () => {
    expect(
      getWebSocketTlsOptions(
        'wss://other.example/v1/realtime',
        ssl(true, ['voxtral.internal.example'])
      )
    ).toEqual({});
  });

  test('keeps verification when ignoreInvalidCertificates is off', () => {
    expect(
      getWebSocketTlsOptions(
        'wss://voxtral.internal.example/',
        ssl(false, ['voxtral.internal.example'])
      )
    ).toEqual({});
  });

  test('keeps verification when the whitelist is empty', () => {
    expect(getWebSocketTlsOptions('wss://voxtral.internal.example/', ssl(true, []))).toEqual({});
  });

  test('adds nothing for plain ws:// or invalid input', () => {
    const cfg = ssl(true, ['voxtral.internal.example']);
    expect(getWebSocketTlsOptions('ws://voxtral.internal.example/', cfg)).toEqual({});
    expect(getWebSocketTlsOptions(undefined, cfg)).toEqual({});
    expect(getWebSocketTlsOptions('not a url', cfg)).toEqual({});
  });
});
