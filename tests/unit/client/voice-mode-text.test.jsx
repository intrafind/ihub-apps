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

  test('something else is passed on as said when the question allows another answer', () => {
    expect(answerForClarification('medium', { ...clarification, allowOther: true })).toEqual({
      value: 'medium',
      displayText: 'medium'
    });
    expect(answerForClarification('medium', { ...clarification, inputType: 'text' })).toEqual({
      value: 'medium',
      displayText: 'medium'
    });
  });

  test('something else is not an answer when the question has a fixed set of options', () => {
    expect(answerForClarification('medium', clarification)).toBeNull();
    expect(answerForClarification('', clarification)).toBeNull();
  });

  test('accepts plain-string options', () => {
    expect(answerForClarification('blue', { options: ['Red', 'Blue'] })).toEqual({
      value: 'Blue',
      displayText: 'Blue'
    });
  });

  describe('Yes / No', () => {
    const yesNo = {
      inputType: 'single_select',
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' }
      ]
    };
    const answerOf = said => answerForClarification(said, yesNo)?.value ?? null;

    test.each([
      ['yes', 'yes'],
      ['Yes.', 'yes'],
      ['yes please', 'yes'],
      ['Yes, go ahead', 'yes'],
      ['no', 'no'],
      ['No thanks', 'no'],
      ['no, I do not want that', 'no']
    ])('%j answers %s', (said, value) => {
      expect(answerOf(said)).toBe(value);
    });

    // Each of these used to be read as Yes or No by looking for the letters
    // inside the words: "know" holds "no", "yesterday" holds "yes".
    test.each([['I do not know yet'], ['yesterday'], ['not now'], ['maybe'], ['notable']])(
      '%j is not understood',
      said => {
        expect(answerForClarification(said, yesNo)).toBeNull();
      }
    );

    test('naming both options is ambiguous, not a guess', () => {
      expect(answerForClarification('yes or no', yesNo)).toBeNull();
      expect(answerForClarification('no, yes, I mean no', yesNo)).toBeNull();
    });

    test('a question that allows another answer takes unclear words as that answer', () => {
      const open = { ...yesNo, allowOther: true };
      for (const said of ['I do not know yet', 'yes or no', 'maybe']) {
        expect(answerForClarification(said, open)).toEqual({ value: said, displayText: said });
      }
      // A clear option still wins over the free text.
      expect(answerForClarification('yes please', open)).toEqual({
        value: 'yes',
        displayText: 'Yes'
      });
    });

    test('works in German too', () => {
      const ja = {
        options: [
          { value: 'ja', label: 'Ja' },
          { value: 'nein', label: 'Nein' }
        ]
      };
      expect(answerForClarification('Nein, danke', ja).value).toBe('nein');
      expect(answerForClarification('ja bitte', ja).value).toBe('ja');
      expect(answerForClarification('Ich weiß nicht', ja)).toBeNull();
      expect(answerForClarification('janein', ja)).toBeNull();
    });
  });

  describe('options with several words', () => {
    const sizes = {
      options: [
        { value: 'large', label: 'Large' },
        { value: 'xl', label: 'Extra large' },
        { value: 'small', label: 'Small' }
      ]
    };

    test('the longest label wins over a label it contains', () => {
      expect(answerForClarification('extra large please', sizes).value).toBe('xl');
      expect(answerForClarification('the large one', sizes).value).toBe('large');
    });

    test('two unrelated options in one sentence are ambiguous', () => {
      expect(answerForClarification('small or large', sizes)).toBeNull();
    });

    test('accents do not split words', () => {
      const options = {
        options: [
          { value: 'für', label: 'Für mich' },
          { value: 'x', label: 'X' }
        ]
      };
      expect(answerForClarification('für mich', options).value).toBe('für');
      expect(answerForClarification('fur mich bitte', options).value).toBe('für');
    });
  });

  describe('single-character options', () => {
    const letters = {
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' }
      ]
    };

    test('are answered by saying just the letter or "option a"', () => {
      expect(answerForClarification('A', letters).value).toBe('a');
      expect(answerForClarification('b.', letters).value).toBe('b');
      expect(answerForClarification('Option B', letters).value).toBe('b');
      expect(answerForClarification('Antwort a', letters).value).toBe('a');
    });

    test('are not found inside a sentence: every sentence has an "a"', () => {
      expect(answerForClarification('I want a large one', letters)).toBeNull();
      expect(answerForClarification('what is b', letters)).toBeNull();
    });

    test('numbers work the same way', () => {
      const numbers = {
        options: [
          { value: '1', label: '1' },
          { value: '2', label: '2' }
        ]
      };
      expect(answerForClarification('two', numbers)).toBeNull();
      expect(answerForClarification('2', numbers).value).toBe('2');
      expect(answerForClarification('I have 2 kids', numbers)).toBeNull();
    });
  });

  describe('multi-select questions', () => {
    const colours = {
      inputType: 'multi_select',
      options: [
        { value: 'red', label: 'Red' },
        { value: 'blue', label: 'Blue' },
        { value: 'dark-green', label: 'Dark green' },
        { value: 'green', label: 'Green' }
      ]
    };

    test('every option named is selected, as an array in the order of the options', () => {
      expect(answerForClarification('Red and blue', colours)).toEqual({
        value: ['red', 'blue'],
        displayText: 'Red, Blue'
      });
      expect(answerForClarification('blue, then red please', colours)).toEqual({
        value: ['red', 'blue'],
        displayText: 'Red, Blue'
      });
    });

    test('one option is still an array, so the server sees a selection', () => {
      expect(answerForClarification('Red', colours)).toEqual({
        value: ['red'],
        displayText: 'Red'
      });
    });

    test('a longer label wins over the shorter one inside it', () => {
      expect(answerForClarification('dark green and red', colours).value).toEqual([
        'red',
        'dark-green'
      ]);
      expect(answerForClarification('green', colours).value).toEqual(['green']);
    });

    test('an option said twice is selected once', () => {
      expect(answerForClarification('red, red and blue', colours).value).toEqual(['red', 'blue']);
    });

    test('the number of selections the question allows is respected', () => {
      const atLeastTwo = { ...colours, validation: { min: 2 } };
      expect(answerForClarification('Red', atLeastTwo)).toBeNull();
      expect(answerForClarification('Red and blue', atLeastTwo).value).toEqual(['red', 'blue']);
      const atMostOne = { ...colours, validation: { max: 1 } };
      expect(answerForClarification('Red and blue', atMostOne)).toBeNull();
      expect(answerForClarification('Blue', atMostOne).value).toEqual(['blue']);
    });

    test('no option named: not understood, unless another answer is allowed', () => {
      expect(answerForClarification('whatever you like', colours)).toBeNull();
      expect(answerForClarification('purple', { ...colours, allowOther: true })).toEqual({
        value: ['purple'],
        displayText: 'purple'
      });
    });

    test('single-select questions still take one option only', () => {
      const single = { ...colours, inputType: 'single_select' };
      expect(answerForClarification('Red and blue', single)).toBeNull();
      expect(answerForClarification('Red', single).value).toBe('red');
    });
  });
});
