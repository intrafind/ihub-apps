// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Sending the admin's pick of a gateway sync to the server: only the kind and
 * remote id of each item go out, the server's outcome per item comes back, and a
 * request that fails as a whole fails every item.
 */

jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: jest.fn(),
  getAdminApiErrorMessage: err => err?.message || 'failed'
}));

const {
  applyGatewaySync,
  countByKind,
  formatChangeValue,
  itemKey
} = require('../../../client/src/features/admin/utils/gatewaySync');

const ADDED = {
  kind: 'added',
  remoteId: 'mistral-large-3',
  name: 'mistral-large-3',
  model: { id: 'gw-mistral-large-3', modelId: 'mistral-large-3', provider: 'mistral' }
};
const CHANGED = {
  kind: 'changed',
  remoteId: 'qwen3-vl',
  modelId: 'gw-qwen',
  changes: [{ field: 'contextWindow', from: 4096, to: 32768 }]
};
const REMOVED = { kind: 'removed', remoteId: 'retired', modelId: 'gw-retired', reason: 'missing' };

describe('small helpers', () => {
  it('keys an item by kind and remote model', () => {
    expect(itemKey(ADDED)).toBe('added:mistral-large-3');
    expect(itemKey({ ...ADDED, kind: 'changed' })).toBe('changed:mistral-large-3');
  });

  it('counts the items of each kind', () => {
    expect(countByKind([ADDED, CHANGED, REMOVED, { ...REMOVED, remoteId: 'x' }])).toEqual({
      added: 1,
      changed: 1,
      removed: 2
    });
    expect(countByKind(undefined)).toEqual({ added: 0, changed: 0, removed: 0 });
  });

  it('shows values exactly, switches as yes/no and an unset value as a dash', () => {
    expect(formatChangeValue('contextWindow', 32768)).toBe('32768');
    expect(formatChangeValue('contextWindow', null)).toBe('—');
    expect(formatChangeValue('supportsVision', true, { yes: 'Ja', no: 'Nein' })).toBe('Ja');
    expect(formatChangeValue('supportsVision', false, { yes: 'Ja', no: 'Nein' })).toBe('Nein');
    expect(formatChangeValue('url', 'https://gw/x')).toBe('https://gw/x');
  });
});

describe('applyGatewaySync', () => {
  it('sends only the kind and remote id of each pick, never a model config', async () => {
    const call = jest.fn(async () => ({ data: { items: [] } }));
    await applyGatewaySync('ifinder-gw', [ADDED, CHANGED, REMOVED], call);

    expect(call).toHaveBeenCalledTimes(1);
    const [path, options] = call.mock.calls[0];
    expect(path).toBe('/admin/providers/ifinder-gw/_sync-models');
    expect(options.method).toBe('POST');
    expect(options.body).toEqual({
      items: [
        { kind: 'added', remoteId: 'mistral-large-3' },
        { kind: 'changed', remoteId: 'qwen3-vl' },
        { kind: 'removed', remoteId: 'retired' }
      ]
    });
  });

  it('gives each item the outcome the server reported', async () => {
    const call = jest.fn(async () => ({
      data: {
        items: [
          { kind: 'added', remoteId: 'mistral-large-3', modelId: 'gw-m', status: 'applied' },
          {
            kind: 'changed',
            remoteId: 'qwen3-vl',
            status: 'skipped',
            detail: 'changedSinceReview'
          },
          { kind: 'removed', remoteId: 'retired', status: 'failed', detail: 'disk full' }
        ]
      }
    }));
    const results = await applyGatewaySync('ifinder-gw', [ADDED, CHANGED, REMOVED], call);

    expect(results).toEqual([
      {
        key: 'added:mistral-large-3',
        kind: 'added',
        status: 'applied',
        ok: true,
        detail: undefined
      },
      {
        key: 'changed:qwen3-vl',
        kind: 'changed',
        status: 'skipped',
        ok: false,
        detail: 'changedSinceReview'
      },
      { key: 'removed:retired', kind: 'removed', status: 'failed', ok: false, detail: 'disk full' }
    ]);
  });

  it('fails every item, with the reason, when the request fails as a whole', async () => {
    const call = jest.fn(async () => {
      throw new Error('Provider ifinder-gw not found');
    });
    const results = await applyGatewaySync('ifinder-gw', [ADDED, REMOVED], call);

    expect(results.map(r => [r.key, r.status, r.ok])).toEqual([
      ['added:mistral-large-3', 'failed', false],
      ['removed:retired', 'failed', false]
    ]);
    expect(results[0].detail).toBe('Provider ifinder-gw not found');
  });

  it('sends nothing for no items', async () => {
    const call = jest.fn();
    expect(await applyGatewaySync('ifinder-gw', [], call)).toEqual([]);
    expect(call).not.toHaveBeenCalled();
  });

  it('escapes the provider id in the path', async () => {
    const call = jest.fn(async () => ({ data: { items: [] } }));
    await applyGatewaySync('a/b c', [ADDED], call);
    expect(call.mock.calls[0][0]).toBe('/admin/providers/a%2Fb%20c/_sync-models');
  });
});
