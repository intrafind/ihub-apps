// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sendCreated, sendWithLocation, segment } from '../utils/created.js';

function makeRes() {
  const res = { statusCode: 200, headers: {}, body: null };
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.setHeader = (name, value) => {
    res.headers[name] = value;
    return res;
  };
  res.json = value => {
    res.body = value;
    return res;
  };
  return res;
}

describe('sendCreated', () => {
  it('answers 201 with the body and the Location of the new resource', () => {
    const res = makeRes();
    sendCreated(res, '/api/admin/apps/new-app', { app: { id: 'new-app' } });
    assert.equal(res.statusCode, 201);
    assert.equal(res.headers.Location, '/api/admin/apps/new-app');
    assert.deepEqual(res.body, { app: { id: 'new-app' } });
  });

  it('encodes an id so it stays one path segment', () => {
    assert.equal(segment('a/b c'), 'a%2Fb%20c');
    const res = makeRes();
    sendCreated(res, `/api/things/${segment('x/../y')}`, {});
    assert.equal(res.headers.Location, '/api/things/x%2F..%2Fy');
  });

  it('sets Location for a 201 or 202 but not for another status', () => {
    for (const status of [201, 202]) {
      const res = makeRes();
      sendWithLocation(res, status, '/api/things/a', { id: 'a' });
      assert.equal(res.statusCode, status);
      assert.equal(res.headers.Location, '/api/things/a');
    }
    const res = makeRes();
    sendWithLocation(res, 200, '/api/things/a', { id: 'a' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers.Location, undefined);
  });
});
