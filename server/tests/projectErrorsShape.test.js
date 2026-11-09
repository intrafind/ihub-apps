// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `ProjectError` and `KnowledgeError` are `ServiceError`s: the project routes let them propagate and
 * the global error middleware answers with the domain code at the top level (`code`), the extras in
 * `details` and the status the error carries. Every code they throw is in the shared registry with
 * an English and a German text.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { API_ERROR_CODES } from '../../shared/apiErrors.js';
import { toErrorResponse } from '../utils/errorResponse.js';
import { ServiceError } from '../utils/ServiceError.js';
import { ProjectError, STATUS_BY_CODE } from '../services/projects/projectErrors.js';
import { KnowledgeError } from '../services/knowledge/types.js';

const en = JSON.parse(readFileSync(new URL('../../shared/i18n/en.json', import.meta.url), 'utf8'));
const de = JSON.parse(readFileSync(new URL('../../shared/i18n/de.json', import.meta.url), 'utf8'));

const KNOWLEDGE_CODES = [
  'ITEM_NOT_READY',
  'SOURCE_FORBIDDEN',
  'KEY_ACCESS_DENIED',
  'SOURCE_GONE',
  'ITEM_NOT_FOUND',
  'PROJECT_NOT_FOUND',
  'STORAGE_UNAVAILABLE',
  'TEXT_UNAVAILABLE'
];

describe('ProjectError answers', () => {
  it('is a ServiceError that answers its own status and the code at the top level', () => {
    const error = new ProjectError('QUOTA_FILES', 'A project holds at most 5 items', {
      limit: 5,
      used: 5
    });
    assert.ok(error instanceof ServiceError);
    const { status, body, headers } = toErrorResponse(error);
    assert.equal(status, 413);
    assert.equal(body.code, 'QUOTA_FILES');
    assert.equal(body.status, 413);
    assert.equal(body.detail, 'A project holds at most 5 items');
    assert.deepEqual(body.details, { limit: 5, used: 5 });
    assert.match(headers['Content-Type'], /application\/problem\+json/);
  });

  it('keeps the project status where the shared registry default differs', () => {
    assert.equal(toErrorResponse(new ProjectError('UNSUPPORTED_TYPE', 'x')).status, 415);
    assert.equal(toErrorResponse(new ProjectError('NO_TEXT', 'x')).status, 422);
  });

  it('answers a code without a status as 400', () => {
    const { status, body } = toErrorResponse(new ProjectError('SOMETHING_NEW', 'x'));
    assert.equal(status, 400);
    assert.equal(body.code, 'SOMETHING_NEW');
  });
});

describe('KnowledgeError answers', () => {
  const expected = {
    ITEM_NOT_READY: 409,
    SOURCE_FORBIDDEN: 403,
    KEY_ACCESS_DENIED: 403,
    SOURCE_GONE: 404,
    ITEM_NOT_FOUND: 404,
    PROJECT_NOT_FOUND: 404,
    STORAGE_UNAVAILABLE: 503,
    TEXT_UNAVAILABLE: 410
  };

  for (const [code, status] of Object.entries(expected)) {
    it(`answers ${code} as ${status} with the code at the top level`, () => {
      const error = new KnowledgeError(code, 'nope', { projectId: 'prj_1', itemId: 'itm_1' });
      assert.ok(error instanceof ServiceError);
      const { status: answered, body } = toErrorResponse(error);
      assert.equal(answered, status);
      assert.equal(body.code, code);
      assert.equal(error.projectId, 'prj_1');
      assert.equal(error.itemId, 'itm_1');
    });
  }

  it('answers any other code as 400', () => {
    assert.equal(toErrorResponse(new KnowledgeError('NOT_SUPPORTED', 'x')).status, 400);
  });
});

describe('the registry holds every project error code', () => {
  const codes = [...new Set([...Object.keys(STATUS_BY_CODE), ...KNOWLEDGE_CODES])];

  for (const code of codes) {
    it(`${code} is registered with an English and a German text`, () => {
      assert.ok(code in API_ERROR_CODES, `${code} is missing from shared/apiErrors.js`);
      assert.ok(en.apiErrors[code], `${code} has no English text`);
      assert.ok(de.apiErrors[code], `${code} has no German text`);
    });
  }
});
