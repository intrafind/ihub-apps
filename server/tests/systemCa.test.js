// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, expect, jest, test } from '@jest/globals';
import { applySystemCaDefault } from '../utils/systemCa.js';

const fakeTls = (system = ['sys-a', 'sys-b']) => ({
  getCACertificates: jest.fn(type => (type === 'system' ? system : ['mozilla'])),
  setDefaultCACertificates: jest.fn()
});

const run = (overrides = {}) => {
  const tlsModule = overrides.tlsModule || fakeTls();
  const result = applySystemCaDefault({ env: {}, execArgv: [], ...overrides, tlsModule });
  return { result, tlsModule };
};

describe('applySystemCaDefault', () => {
  test('adds the system roots to the bundled ones', () => {
    const { result, tlsModule } = run();
    expect(result).toEqual({ applied: true, reason: 'applied', count: 2 });
    expect(tlsModule.setDefaultCACertificates).toHaveBeenCalledWith(['mozilla', 'sys-a', 'sys-b']);
  });

  test.each(['0', 'false', 'OFF', 'no'])('NODE_USE_SYSTEM_CA=%s opts out', value => {
    const { result, tlsModule } = run({ env: { NODE_USE_SYSTEM_CA: value } });
    expect(result).toEqual({ applied: false, reason: 'disabled' });
    expect(tlsModule.setDefaultCACertificates).not.toHaveBeenCalled();
  });

  test('leaves the store to Node when NODE_USE_SYSTEM_CA=1', () => {
    const { result, tlsModule } = run({ env: { NODE_USE_SYSTEM_CA: '1' } });
    expect(result.reason).toBe('node-managed');
    expect(tlsModule.setDefaultCACertificates).not.toHaveBeenCalled();
  });

  test.each([
    [{ execArgv: ['--use-openssl-ca'] }],
    [{ execArgv: ['--use-system-ca'] }],
    [{ env: { NODE_OPTIONS: '--max-old-space-size=512 --use-openssl-ca' } }]
  ])('respects an explicit CA flag %j', overrides => {
    const { result, tlsModule } = run(overrides);
    expect(result).toEqual({ applied: false, reason: 'explicit-ca-flag' });
    expect(tlsModule.setDefaultCACertificates).not.toHaveBeenCalled();
  });

  test('does nothing on a Node without setDefaultCACertificates', () => {
    const { result } = run({ tlsModule: { getCACertificates: () => [] } });
    expect(result).toEqual({ applied: false, reason: 'unsupported-node' });
  });

  test('keeps the bundled roots when the system store is empty', () => {
    const { result, tlsModule } = run({ tlsModule: fakeTls([]) });
    expect(result.reason).toBe('no-system-certificates');
    expect(tlsModule.setDefaultCACertificates).not.toHaveBeenCalled();
  });

  test('a failing store lookup is reported, not thrown', () => {
    const tlsModule = fakeTls();
    tlsModule.getCACertificates.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(run({ tlsModule }).result).toEqual({ applied: false, reason: 'error: boom' });
  });
});
