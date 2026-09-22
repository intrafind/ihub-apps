#!/usr/bin/env node

/**
 * Specs for the Outlook add-in's default answer action
 * (`officeIntegration.defaultMailAction`), as read by the two server endpoints:
 *
 * - the public add-in config endpoint *sanitizes* — a hand-edited
 *   platform.json must never break the task pane, so the value always comes
 *   out as one the pane knows;
 * - the admin config endpoint *validates* — a bad save is rejected with a
 *   reason instead of being silently repaired.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_OFFICE_MAIL_ACTION,
  OFFICE_MAIL_ACTIONS,
  OFFICE_MAIL_ACTION_CHOICES,
  sanitizeOfficeMailAction,
  validateOfficeMailAction
} from '../utils/officeMailActions.js';

test('the accepted choices are the five actions plus the automatic default', () => {
  assert.deepEqual(OFFICE_MAIL_ACTIONS, ['answer', 'answerAll', 'forward', 'new', 'insert']);
  assert.deepEqual(OFFICE_MAIL_ACTION_CHOICES, [
    'auto',
    'answer',
    'answerAll',
    'forward',
    'new',
    'insert'
  ]);
  assert.equal(DEFAULT_OFFICE_MAIL_ACTION, 'auto');
});

test('sanitize: nothing configured means the context-dependent default', () => {
  assert.equal(sanitizeOfficeMailAction(undefined), 'auto');
  assert.equal(sanitizeOfficeMailAction(null), 'auto');
  assert.equal(sanitizeOfficeMailAction(''), 'auto');
});

test('sanitize: a hand-edited value the pane does not know falls back, never throws', () => {
  assert.equal(sanitizeOfficeMailAction('reply-all'), 'auto');
  assert.equal(sanitizeOfficeMailAction(42), 'auto');
  assert.equal(sanitizeOfficeMailAction({ action: 'forward' }), 'auto');
  assert.equal(sanitizeOfficeMailAction(['forward']), 'auto');
  // Case matters: the ids are the ones the client ships.
  assert.equal(sanitizeOfficeMailAction('AnswerAll'), 'auto');
});

test('sanitize: every known choice survives untouched', () => {
  for (const choice of OFFICE_MAIL_ACTION_CHOICES) {
    assert.equal(sanitizeOfficeMailAction(choice), choice);
  }
});

test('validate: every known choice is accepted', () => {
  for (const choice of OFFICE_MAIL_ACTION_CHOICES) {
    assert.deepEqual(validateOfficeMailAction(choice), { value: choice });
  }
});

test('validate: clearing the field resets it to the automatic default', () => {
  assert.deepEqual(validateOfficeMailAction(''), { value: 'auto' });
  assert.deepEqual(validateOfficeMailAction(null), { value: 'auto' });
});

test('validate: an unknown value is reported, not repaired', () => {
  const result = validateOfficeMailAction('reply-all');
  assert.ok(result.error, 'expected an error');
  assert.equal(result.value, undefined);
  // The message names what is accepted, so the admin can fix it.
  assert.match(result.error, /answerAll/);
});

test('validate: non-string input is rejected', () => {
  assert.ok(validateOfficeMailAction(0).error);
  assert.ok(validateOfficeMailAction(true).error);
  assert.ok(validateOfficeMailAction(['forward']).error);
  assert.ok(validateOfficeMailAction({}).error);
});
