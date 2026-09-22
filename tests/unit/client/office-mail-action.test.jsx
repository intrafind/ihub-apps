/**
 * Unit tests for client/src/features/office/utilities/officeMailAction.js
 *
 * Issue #2446: the task pane's answer buttons became five distinct actions and
 * the default among them is configurable. What these tests pin is the part
 * that has to hold whatever Outlook is doing:
 *
 * - each Outlook mode offers only the actions its API supports — the openers
 *   in read mode, the draft writer while composing;
 * - the context defaults are reply-all in the reading pane (no recipient of a
 *   thread quietly dropped) and insert inside a draft;
 * - resolution runs user override → admin default → context default, and
 *   skips a configured choice the current mode cannot offer.
 */

import '@testing-library/jest-dom';

const MODULE_PATH = '../../../client/src/features/office/utilities/officeMailAction';
const STORAGE_KEY = 'office_ihub_mail_action';

/** Fresh module instance per test — the preference is read from localStorage. */
function loadModule() {
  let mod;
  jest.isolateModules(() => {
    mod = require(MODULE_PATH);
  });
  return mod;
}

beforeEach(() => {
  localStorage.clear();
});

test('the choices an admin or a user may pick are the five actions plus auto', () => {
  const m = loadModule();
  expect(m.OFFICE_MAIL_ACTIONS).toEqual(['answer', 'answerAll', 'forward', 'new', 'insert']);
  expect(m.OFFICE_MAIL_ACTION_CHOICES).toEqual([
    'auto',
    'answer',
    'answerAll',
    'forward',
    'new',
    'insert'
  ]);
  expect(m.DEFAULT_OFFICE_MAIL_ACTION).toBe('auto');
});

test('read mode offers the openers, with reply-all first; insert has no target there', () => {
  const m = loadModule();
  expect(m.actionsForMode('read')).toEqual(['answerAll', 'answer', 'forward', 'new']);
  expect(m.isMailActionAvailable('insert', 'read')).toBe(false);
});

test('compose mode offers only insert — the reply openers are meaningless in a draft', () => {
  const m = loadModule();
  expect(m.actionsForMode('compose')).toEqual(['insert']);
  for (const action of ['answer', 'answerAll', 'forward', 'new']) {
    expect(m.isMailActionAvailable(action, 'compose')).toBe(false);
  }
});

test('a host that is not an Outlook mail surface offers nothing', () => {
  const m = loadModule();
  expect(m.actionsForMode(null)).toEqual([]);
  expect(m.actionsForMode('appointment')).toEqual([]);
  expect(m.resolveDefaultMailAction({ mode: null })).toBeNull();
});

test('with nothing configured the default follows the open item', () => {
  const m = loadModule();
  expect(m.resolveDefaultMailAction({ mode: 'read' })).toBe('answerAll');
  expect(m.resolveDefaultMailAction({ mode: 'compose' })).toBe('insert');
});

test('the admin default wins over the context default', () => {
  const m = loadModule();
  expect(m.resolveDefaultMailAction({ mode: 'read', adminDefault: 'forward' })).toBe('forward');
});

test('the user override wins over the admin default', () => {
  const m = loadModule();
  expect(
    m.resolveDefaultMailAction({ mode: 'read', adminDefault: 'forward', userPreference: 'new' })
  ).toBe('new');
});

test('"auto" is not a choice — it defers to the next level', () => {
  const m = loadModule();
  expect(
    m.resolveDefaultMailAction({
      mode: 'read',
      adminDefault: 'forward',
      userPreference: 'auto'
    })
  ).toBe('forward');
  expect(
    m.resolveDefaultMailAction({ mode: 'read', adminDefault: 'auto', userPreference: 'auto' })
  ).toBe('answerAll');
});

test('a configured action the current mode cannot offer falls back to one it can', () => {
  const m = loadModule();
  // An admin who prefers reply-all still gets Insert inside a draft.
  expect(m.resolveDefaultMailAction({ mode: 'compose', adminDefault: 'answerAll' })).toBe('insert');
  // …and a user who prefers Insert still gets an opener in the reading pane.
  expect(m.resolveDefaultMailAction({ mode: 'read', userPreference: 'insert' })).toBe('answerAll');
});

test('the user preference persists under an office_-prefixed key', () => {
  const m = loadModule();
  expect(m.getStoredMailActionPreference()).toBe('auto');

  expect(m.setMailActionPreference('forward')).toBe(true);
  expect(localStorage.getItem(STORAGE_KEY)).toBe('forward');
  // Survives an Outlook restart: a fresh module instance reads it back.
  expect(loadModule().getStoredMailActionPreference()).toBe('forward');
});

test('an unknown preference is refused rather than stored', () => {
  const m = loadModule();
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  expect(m.setMailActionPreference('reply-all')).toBe(false);
  expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  warn.mockRestore();
});

test('a stored value the pane no longer knows reads back as auto', () => {
  localStorage.setItem(STORAGE_KEY, 'replyToEmail');
  expect(loadModule().getStoredMailActionPreference()).toBe('auto');
});

test('a hand-edited admin default is sanitized, never trusted', () => {
  const m = loadModule();
  expect(m.readAdminMailActionDefault('answer')).toBe('answer');
  expect(m.readAdminMailActionDefault('reply-all')).toBe('auto');
  expect(m.readAdminMailActionDefault(undefined)).toBe('auto');
  expect(m.readAdminMailActionDefault({ action: 'answer' })).toBe('auto');
});
