#!/usr/bin/env node

/**
 * Specs for the Outlook add-in's start-page settings
 * (`officeIntegration.startPage`), as read by the two server endpoints:
 *
 * - the public add-in config endpoint *sanitizes* — a hand-edited
 *   platform.json must never break the task pane, so every field comes out
 *   present and well-formed;
 * - the admin config endpoint *validates* — a bad save is rejected with a
 *   reason instead of being silently repaired.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OFFICE_START_PAGE_CHOICES,
  DEFAULT_OFFICE_START_PAGE,
  MAX_OFFICE_FEATURED_APPS,
  sanitizeOfficeStartPage,
  validateOfficeStartPage
} from '../utils/officeStartPage.js';

test('the accepted choices are the two the admin UI offers', () => {
  assert.deepEqual(OFFICE_START_PAGE_CHOICES, ['start', 'apps']);
  assert.equal(DEFAULT_OFFICE_START_PAGE, 'start');
});

test('sanitize: nothing configured means the start page with no curated apps', () => {
  const expected = { defaultPage: 'start', featuredAppIds: [] };
  assert.deepEqual(sanitizeOfficeStartPage(undefined), expected);
  assert.deepEqual(sanitizeOfficeStartPage(null), expected);
  assert.deepEqual(sanitizeOfficeStartPage({}), expected);
  assert.deepEqual(sanitizeOfficeStartPage('start'), expected);
  assert.deepEqual(sanitizeOfficeStartPage(['apps']), expected);
});

test('sanitize: keeps valid values and omits an unset default app', () => {
  assert.deepEqual(
    sanitizeOfficeStartPage({
      defaultPage: 'apps',
      defaultAppId: 'email-assistant',
      featuredAppIds: ['summarizer', 'translator']
    }),
    {
      defaultPage: 'apps',
      defaultAppId: 'email-assistant',
      featuredAppIds: ['summarizer', 'translator']
    }
  );
  assert.equal('defaultAppId' in sanitizeOfficeStartPage({ defaultAppId: '' }), false);
});

test('sanitize: repairs hand-edited garbage instead of passing it to the pane', () => {
  const out = sanitizeOfficeStartPage({
    defaultPage: 'nonsense',
    defaultAppId: '../etc/passwd',
    featuredAppIds: ['ok-app', 42, null, 'Bad Id', 'ok-app', '', { id: 'x' }]
  });
  assert.equal(out.defaultPage, 'start');
  assert.equal('defaultAppId' in out, false);
  // Invalid entries and duplicates are dropped; valid ones keep their order.
  assert.deepEqual(out.featuredAppIds, ['ok-app']);
});

test('sanitize: caps the curated list', () => {
  const many = Array.from({ length: MAX_OFFICE_FEATURED_APPS + 5 }, (_, i) => `app-${i}`);
  assert.equal(
    sanitizeOfficeStartPage({ featuredAppIds: many }).featuredAppIds.length,
    MAX_OFFICE_FEATURED_APPS
  );
});

test('validate: a complete object is normalized to the known fields', () => {
  assert.deepEqual(
    validateOfficeStartPage({
      defaultPage: 'apps',
      defaultAppId: 'email-assistant',
      featuredAppIds: ['a', 'b'],
      somethingElse: true
    }),
    { value: { defaultPage: 'apps', defaultAppId: 'email-assistant', featuredAppIds: ['a', 'b'] } }
  );
});

test('validate: unset fields fall back to their defaults', () => {
  assert.deepEqual(validateOfficeStartPage({}), {
    value: { defaultPage: 'start', featuredAppIds: [] }
  });
  // The admin UI sends '' for "automatic" — that clears the default app.
  assert.deepEqual(
    validateOfficeStartPage({ defaultPage: '', defaultAppId: '', featuredAppIds: null }),
    {
      value: { defaultPage: 'start', featuredAppIds: [] }
    }
  );
});

test('validate: rejects anything that is not an object', () => {
  for (const bad of [undefined, null, 'start', 3, ['start']]) {
    assert.match(validateOfficeStartPage(bad).error, /must be an object/);
  }
});

test('validate: rejects an unknown page choice', () => {
  assert.match(
    validateOfficeStartPage({ defaultPage: 'page' }).error,
    /defaultPage must be one of/
  );
});

test('validate: rejects ids that do not look like app ids', () => {
  assert.match(validateOfficeStartPage({ defaultAppId: 'Not An Id' }).error, /defaultAppId/);
  assert.match(validateOfficeStartPage({ defaultAppId: 42 }).error, /defaultAppId/);
  assert.match(validateOfficeStartPage({ featuredAppIds: 'a,b' }).error, /must be an array/);
  assert.match(validateOfficeStartPage({ featuredAppIds: ['ok', '../x'] }).error, /valid app ids/);
  assert.match(validateOfficeStartPage({ featuredAppIds: ['a', 'a'] }).error, /duplicates/);
  const many = Array.from({ length: MAX_OFFICE_FEATURED_APPS + 1 }, (_, i) => `app-${i}`);
  assert.match(validateOfficeStartPage({ featuredAppIds: many }).error, /more than/);
});
