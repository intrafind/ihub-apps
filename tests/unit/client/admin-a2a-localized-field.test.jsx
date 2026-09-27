/**
 * Unit tests for client/src/features/admin/utils/localizedField.js — the A2A
 * agents dialog edits one language of a name or description and must keep the
 * other translations when it saves (the PUT route replaces the whole agent).
 */
import {
  editableText,
  mergeLocalizedText
} from '../../../client/src/features/admin/utils/localizedField';

describe('editableText', () => {
  test('shows English when present, else the first language, else nothing', () => {
    expect(editableText({ en: 'Langdock', de: 'Langdock-Agent' })).toEqual({
      text: 'Langdock',
      lang: 'en'
    });
    expect(editableText({ de: 'Nur Deutsch' })).toEqual({ text: 'Nur Deutsch', lang: 'de' });
    expect(editableText('plain')).toEqual({ text: 'plain', lang: 'en' });
    expect(editableText(undefined)).toEqual({ text: '', lang: 'en' });
  });
});

describe('mergeLocalizedText', () => {
  test('keeps the other languages when one is edited', () => {
    const stored = { en: 'Langdock', de: 'Langdock-Agent' };
    expect(mergeLocalizedText(stored, 'Langdock agent', 'en')).toEqual({
      en: 'Langdock agent',
      de: 'Langdock-Agent'
    });
    // Saving without touching the text (e.g. only the timeout changed).
    expect(mergeLocalizedText(stored, 'Langdock', 'en')).toEqual(stored);
    expect(stored).toEqual({ en: 'Langdock', de: 'Langdock-Agent' });
  });

  test('writes back into the language the form showed', () => {
    expect(mergeLocalizedText({ de: 'Alt' }, 'Neu', 'de')).toEqual({ de: 'Neu' });
  });

  test('turns a plain or missing value into an English entry', () => {
    expect(mergeLocalizedText('old', 'new')).toEqual({ en: 'new' });
    expect(mergeLocalizedText(undefined, 'new')).toEqual({ en: 'new' });
  });

  test('clearing a language removes only that one', () => {
    expect(mergeLocalizedText({ en: 'x', de: 'y' }, '', 'en')).toEqual({ de: 'y' });
    expect(mergeLocalizedText({ en: 'x' }, '', 'en')).toBeUndefined();
    expect(mergeLocalizedText(undefined, '')).toBeUndefined();
  });
});
