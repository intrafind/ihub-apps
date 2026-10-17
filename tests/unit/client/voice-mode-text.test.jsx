/**
 * Helpers that turn the chat's state into what voice mode says and shows
 * (issue #2868): citation-free speech, the tool status label and spoken answers
 * to a question the app asked.
 */
import {
  activeToolOf,
  answerForClarification,
  toSpokenText,
  toolStatusLabel
} from '../../../client/src/features/voice/utils/voiceText';

const t = (key, fallback) => fallback;

describe('toSpokenText', () => {
  test('drops citation markers and keeps the sentence intact', () => {
    expect(
      toSpokenText('Revenue grew 4 % [1](https://a.example/x)[2](https://b.example/). Next.')
    ).toBe('Revenue grew 4 %. Next.');
    expect(toSpokenText('It is true [1] and known [12].')).toBe('It is true and known.');
  });

  test('leaves ordinary links and brackets alone', () => {
    expect(toSpokenText('See [the docs](https://a.example/) and [a] list.')).toBe(
      'See [the docs](https://a.example/) and [a] list.'
    );
  });

  test('tolerates non-strings', () => {
    expect(toSpokenText(undefined)).toBe('');
    expect(toSpokenText(null)).toBe('');
  });
});

describe('activeToolOf', () => {
  test('reports the newest running tool of a streaming message', () => {
    const message = {
      loading: true,
      toolActivity: {
        items: [
          { kind: 'search', scope: 'web', status: 'completed' },
          { kind: 'search', scope: 'documents', status: 'running' }
        ]
      }
    };
    expect(activeToolOf(message)).toEqual({ kind: 'search', scope: 'documents' });
  });

  test('falls back to the provider search status, and is null once the message is done', () => {
    expect(activeToolOf({ loading: true, searchStatus: { phase: 'x' } })).toEqual({
      kind: 'search',
      scope: 'web'
    });
    expect(
      activeToolOf({
        loading: false,
        toolActivity: { items: [{ kind: 'tool', status: 'running' }] }
      })
    ).toBeNull();
    expect(activeToolOf(null)).toBeNull();
    expect(activeToolOf({ loading: true })).toBeNull();
  });
});

describe('toolStatusLabel', () => {
  test('words each kind of work', () => {
    expect(toolStatusLabel({ kind: 'search', scope: 'web' }, t)).toBe('Searching the web…');
    expect(toolStatusLabel({ kind: 'search', scope: 'documents' }, t)).toBe(
      'Looking in the documents…'
    );
    expect(toolStatusLabel({ kind: 'fetch', scope: 'web' }, t)).toBe('Reading a page…');
    expect(toolStatusLabel({ kind: 'tool', scope: null }, t)).toBe('Working on it…');
  });
});

describe('answerForClarification', () => {
  const clarification = {
    options: [
      { value: 'small', label: 'Small' },
      { value: 'large', label: 'Large size' }
    ]
  };

  test('without options the words are the answer', () => {
    expect(answerForClarification('  my budget is tight ', { options: [] })).toEqual({
      value: 'my budget is tight',
      displayText: 'my budget is tight'
    });
    expect(answerForClarification('hello', null)).toEqual({ value: 'hello', displayText: 'hello' });
  });

  test('an option said aloud answers with its value, however it was punctuated or cased', () => {
    expect(answerForClarification('Small.', clarification)).toEqual({
      value: 'small',
      displayText: 'Small'
    });
    expect(answerForClarification('I would take the large size please', clarification)).toEqual({
      value: 'large',
      displayText: 'Large size'
    });
  });

  test('something else is passed on as said', () => {
    expect(answerForClarification('medium', clarification)).toEqual({
      value: 'medium',
      displayText: 'medium'
    });
  });

  test('accepts plain-string options', () => {
    expect(answerForClarification('blue', { options: ['Red', 'Blue'] })).toEqual({
      value: 'Blue',
      displayText: 'Blue'
    });
  });
});
