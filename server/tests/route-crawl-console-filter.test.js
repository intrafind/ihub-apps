// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConsoleFilter } from '../../tests/e2e/helpers/consoleFilter.js';

const apiError = url =>
  `API Error: Request failed with status code 400 {status: 400, userFriendlyMessage: x, url: ${url}}`;

test('an expected failure excuses its own request line and the wrapper right after it', () => {
  const filter = createConsoleFilter();
  filter.expectFailure('/api/admin/oauth/connections');
  assert.equal(filter.excuses(apiError('/admin/oauth/connections')), true);
  assert.equal(filter.excuses('Error loading connections: Error: x'), true);
});

test('an unrelated console error after an expected failure is reported', () => {
  const filter = createConsoleFilter();
  filter.expectFailure('/api/admin/oauth/connections');
  // The page handled its failure silently, so no request line was logged; this one is another problem.
  assert.equal(filter.excuses('Failed to render the table: TypeError: x'), false);
});

test('a wrapper line is excused once, and only straight after the request line', () => {
  const filter = createConsoleFilter();
  filter.expectFailure('/api/apps/skill-builder');
  assert.equal(filter.excuses(apiError('/apps/skill-builder')), true);
  assert.equal(filter.excuses('Error loading app: Error: x'), true);
  assert.equal(filter.excuses('Failed to log session start: Error: x'), false);
});

test('an API error for a request that was not expected to fail is reported', () => {
  const filter = createConsoleFilter();
  filter.expectFailure('/api/apps/skill-builder');
  assert.equal(filter.excuses(apiError('/apps/other-app')), false);
  assert.equal(filter.excuses('Error loading app: Error: x'), false);
});

test('encoded ids and the api prefix do not stop a request from matching', () => {
  const filter = createConsoleFilter();
  filter.expectFailure('/api/admin/integrations/installed/com.intrafind%2Fldap-browser');
  assert.equal(
    filter.excuses(apiError('/admin/integrations/installed/com.intrafind%2Fldap-browser')),
    true
  );
});

test('ignored lines never need a report and do not open an exemption', () => {
  const filter = createConsoleFilter([/favicon/]);
  assert.equal(filter.excuses('GET /favicon.ico 404'), true);
  assert.equal(filter.excuses('Failed to log session start'), false);
});
