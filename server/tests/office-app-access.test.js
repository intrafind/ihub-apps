#!/usr/bin/env node

/**
 * Specs for the Outlook add-in's app access — the `allowedApps` list of its OAuth
 * client, as the Office Integration admin page reads and writes it.
 *
 * - `describeOfficeAppAccess` reads what the file holds and reports the state the
 *   server actually enforces, so the page never shows "all apps" for a list that
 *   restricts;
 * - `validateOfficeAllowedApps` rejects a bad save with a reason. An empty list is
 *   the one input that must not be repaired: for this client it means "no
 *   restriction", the opposite of what emptying a limited list intends.
 *
 * The last two tests tie the util to the enforcement in utils/authorization.js, so
 * the two cannot drift apart unnoticed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_APPS,
  MAX_OFFICE_ALLOWED_APPS,
  describeOfficeAppAccess,
  validateOfficeAllowedApps
} from '../utils/officeAppAccess.js';
import { intersectWithClientAllowList } from '../utils/authorization.js';

test('describe: no list, an empty list and the wildcard all mean no restriction', () => {
  const all = { mode: 'all', appIds: [] };
  assert.deepEqual(describeOfficeAppAccess(undefined), all);
  assert.deepEqual(describeOfficeAppAccess(null), all);
  assert.deepEqual(describeOfficeAppAccess([]), all);
  assert.deepEqual(describeOfficeAppAccess(['*']), all);
  assert.deepEqual(describeOfficeAppAccess('*'), all);
});

test('describe: the wildcard wins over the apps listed next to it', () => {
  assert.deepEqual(describeOfficeAppAccess(['summarizer', '*']), { mode: 'all', appIds: [] });
});

test('describe: a list of apps is a limit, in the stored order and without duplicates', () => {
  assert.deepEqual(describeOfficeAppAccess(['translator', 'summarizer', 'translator']), {
    mode: 'limited',
    appIds: ['translator', 'summarizer']
  });
});

test('describe: ids of apps that no longer exist stay visible so they can be removed', () => {
  assert.deepEqual(describeOfficeAppAccess(['deleted-app', 'summarizer']).appIds, [
    'deleted-app',
    'summarizer'
  ]);
});

test('describe: a list with nothing usable still restricts, as the server enforces it', () => {
  // Non-strings are dropped so a hand-edited file cannot break the picker, but
  // the list is still non-empty without a wildcard: the server intersects with
  // it and allows nothing. Reporting "all" here would be false comfort.
  assert.deepEqual(describeOfficeAppAccess([42, null, '']), { mode: 'limited', appIds: [] });
});

test('validate: the wildcard alone, or with anything else, is stored as the wildcard', () => {
  assert.deepEqual(validateOfficeAllowedApps(['*']), { value: ['*'] });
  assert.deepEqual(validateOfficeAllowedApps(['summarizer', '*']), { value: ['*'] });
  assert.equal(ALL_APPS, '*');
});

test('validate: a list of valid ids is kept, duplicates dropped', () => {
  assert.deepEqual(validateOfficeAllowedApps(['summarizer', 'email.assistant', 'summarizer']), {
    value: ['summarizer', 'email.assistant']
  });
});

test('validate: an empty list is refused, not repaired into "no restriction"', () => {
  const { error, value } = validateOfficeAllowedApps([]);
  assert.equal(value, undefined);
  assert.match(error, /must not be empty/);
  assert.match(error, /\["\*"\]/, 'the message names the way to say "all apps"');
});

test('validate: rejects anything that is not an array', () => {
  for (const bad of [undefined, null, '*', 'summarizer', 3, { 0: 'a' }]) {
    assert.match(validateOfficeAllowedApps(bad).error, /must be an array/);
  }
});

test('validate: rejects ids that do not look like app ids', () => {
  for (const bad of ['Not An Id', '../etc/passwd', '', 42, null, 'x'.repeat(51)]) {
    assert.match(validateOfficeAllowedApps(['ok-app', bad]).error, /valid app ids/, String(bad));
  }
});

test('validate: caps the list', () => {
  const many = Array.from({ length: MAX_OFFICE_ALLOWED_APPS + 1 }, (_, i) => `app-${i}`);
  assert.match(validateOfficeAllowedApps(many).error, /more than/);
  assert.equal(
    validateOfficeAllowedApps(many.slice(0, MAX_OFFICE_ALLOWED_APPS)).value.length,
    MAX_OFFICE_ALLOWED_APPS
  );
});

test('the server enforces what the page shows: all leaves the user alone, limited intersects', () => {
  const user = new Set(['summarizer', 'translator', 'hr-bot']);

  // "all" as the page stores it, and as an untouched new client holds it.
  assert.equal(intersectWithClientAllowList(user, ['*']), user);
  assert.equal(intersectWithClientAllowList(user, []), user);

  // "limited": only what the user may open AND the list names.
  assert.deepEqual(
    [...intersectWithClientAllowList(user, ['summarizer', 'not-mine'])],
    ['summarizer']
  );
});

test('the server enforces what the page shows: a user with wildcard access gets exactly the list', () => {
  assert.deepEqual(
    [...intersectWithClientAllowList(new Set(['*']), ['summarizer', 'translator'])],
    ['summarizer', 'translator']
  );
});
