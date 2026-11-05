// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The backup routes answer errors through the global error middleware:
 * `{ error, code, details? }`, with the ZIP headers of the export dropped
 * when the export fails before a byte was sent.
 *
 * Run: node --test server/tests/backup-routes-errors.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { importConfig, exportConfig } from '../routes/admin/backup.js';
import errorHandler from '../middleware/errorHandler.js';
import { ServiceError } from '../utils/ServiceError.js';
import { runHandler } from './helpers/runHandler.js';

function responseDouble() {
  const headers = new Map();
  return {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    headers,
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    removeHeader(name) {
      headers.delete(name.toLowerCase());
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

describe('backup routes errors', () => {
  it('answers an import without a file with BAD_REQUEST', async () => {
    const res = responseDouble();
    await runHandler(importConfig, { headers: {}, user: { id: 'admin' } }, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: 'No ZIP file uploaded', code: 'BAD_REQUEST' });
  });

  it('answers a failed export with JSON, without the ZIP headers', async () => {
    const res = responseDouble();
    const req = { headers: {}, user: { id: 'admin' } };
    // `pipe` of the archive needs a writable; the double has none, so the export fails
    // inside its try block, before any byte is sent.
    let forwarded;
    await exportConfig(req, res, error => {
      forwarded = error;
    });
    assert.ok(forwarded, 'the error is forwarded to the error middleware');
    assert.equal(res.getHeader('content-type'), undefined);
    assert.equal(res.getHeader('content-disposition'), undefined);
    errorHandler(forwarded, req, res, () => {});
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.code, 'INTERNAL_ERROR');
  });

  it('shows the message and details of an IMPORT_FAILED error', () => {
    const res = responseDouble();
    const error = new ServiceError(
      'IMPORT_FAILED',
      'Failed to activate the imported configuration',
      {
        details: { hint: 'The disk is full.', reason: 'ENOSPC' }
      }
    );
    errorHandler(error, { headers: {} }, res, () => {});
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, {
      error: 'Failed to activate the imported configuration',
      code: 'IMPORT_FAILED',
      details: { hint: 'The disk is full.', reason: 'ENOSPC' }
    });
  });
});
