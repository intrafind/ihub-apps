/**
 * Unit tests for client/src/features/office/utilities/officeStarterPrompts.js
 *
 * `combineStarterPromptWithTypedText` is what keeps a note the user typed
 * from being thrown away when they click a starter prompt afterwards.
 */

import '@testing-library/jest-dom';

const {
  combineStarterPromptWithTypedText
} = require('../../../client/src/features/office/utilities/officeStarterPrompts');

describe('combineStarterPromptWithTypedText', () => {
  test('returns the prompt message alone when nothing was typed', () => {
    expect(combineStarterPromptWithTypedText('Generate a reply', '')).toBe('Generate a reply');
    expect(combineStarterPromptWithTypedText('Generate a reply', '   ')).toBe('Generate a reply');
    expect(combineStarterPromptWithTypedText('Generate a reply', undefined)).toBe(
      'Generate a reply'
    );
  });

  test('keeps the typed note under the prompt message', () => {
    expect(combineStarterPromptWithTypedText('Generate a reply', '  Jonas soll das machen. ')).toBe(
      'Generate a reply\n\nJonas soll das machen.'
    );
  });

  test('falls back to the typed note when the prompt has no message', () => {
    expect(combineStarterPromptWithTypedText('', 'Just the note')).toBe('Just the note');
    expect(combineStarterPromptWithTypedText(null, null)).toBe('');
  });
});
