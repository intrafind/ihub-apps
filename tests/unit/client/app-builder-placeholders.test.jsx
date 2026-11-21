// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Input fields and their placeholders (`shared/appPlaceholders.js`). A field
 * reaches the model only where `{{name}}` stands in the instructions or in
 * the message template; a field without one is asked for and then ignored.
 */
import {
  addVariableToTemplate,
  placeholderFromLabel,
  placeholdersIn,
  removeVariables,
  unusedVariables,
  variablesUsedInInstructions
} from '../../../shared/appPlaceholders.js';
import { VARIABLE_NAME_PATTERN } from '../../../shared/validationPatterns.js';

const tone = { name: 'tone', label: { en: 'Tone', de: 'Ton' }, type: 'select' };
const length = { name: 'length', label: { en: 'Length', de: 'Länge' }, type: 'select' };
const audience = { name: 'audience', label: { en: 'Audience' }, type: 'string' };

describe('placeholdersIn', () => {
  test('lists the names in the order of their first occurrence, each once', () => {
    expect(placeholdersIn('{{a}} … {{b}}')).toEqual(['a', 'b']);
    expect(placeholdersIn('{{b}} {{a}} {{b}}')).toEqual(['b', 'a']);
  });

  test('{{content}} is where the message goes, not a field', () => {
    expect(placeholdersIn('Tone: {{tone}}\n{{content}}')).toEqual(['tone']);
    expect(placeholdersIn('{{content}}')).toEqual([]);
  });

  test('reads the syntax the prompt service replaces, and no other', () => {
    expect(placeholdersIn('{{reading_level}} {{target-language}} {{_x}} {{Tone2}}')).toEqual([
      'reading_level',
      'target-language',
      '_x',
      'Tone2'
    ]);
    expect(placeholdersIn('{{ tone }} {tone} {{1st}} {{to ne}} {{}}')).toEqual([]);
  });

  test('finds a placeholder inside other braces', () => {
    expect(placeholdersIn('{"tone": "{{tone}}"} and {{{length}}}')).toEqual(['tone', 'length']);
  });

  test.each([[''], [undefined], [null], [42], [{ en: '{{tone}}' }]])(
    'anything that is not a text (%p) has none',
    text => {
      expect(placeholdersIn(text)).toEqual([]);
    }
  );
});

describe('unusedVariables', () => {
  test('finds a field that neither text references', () => {
    const app = {
      system: { en: 'Write in a {{tone}} tone.' },
      prompt: { en: '{{content}}' },
      variables: [tone, length]
    };

    expect(unusedVariables(app)).toEqual([length]);
  });

  test('{{content}} in a text does not make a field named "content" used by accident', () => {
    const content = { name: 'content', label: { en: 'Content' }, type: 'text' };
    const app = { prompt: { en: '{{content}}' }, variables: [content, tone] };

    expect(unusedVariables(app)).toEqual([content, tone]);
  });

  test('a placeholder in the message template counts', () => {
    const app = {
      system: { en: 'You summarize texts.' },
      prompt: { en: 'Length: {{length}}\n{{content}}' },
      variables: [length]
    };

    expect(unusedVariables(app)).toEqual([]);
  });

  test('a placeholder in any language counts', () => {
    const app = {
      system: { en: 'You summarize texts.', de: 'Ton: {{tone}}' },
      prompt: { en: '{{content}}', de: '{{content}}\nLänge: {{length}}' },
      variables: [tone, length, audience]
    };

    expect(unusedVariables(app)).toEqual([audience]);
  });

  test('a name that only looks alike is not a use', () => {
    const app = {
      system: { en: 'tone, {tone}, {{ tone }}, {{tones}}, {{Tone}}' },
      variables: [tone]
    };

    expect(unusedVariables(app)).toEqual([tone]);
  });

  test('texts given as plain strings are read too', () => {
    expect(unusedVariables({ system: 'A {{tone}} answer.', variables: [tone, length] })).toEqual([
      length
    ]);
  });

  test('an app without fields, or without texts, is handled', () => {
    expect(unusedVariables({})).toEqual([]);
    expect(unusedVariables(null)).toEqual([]);
    expect(unusedVariables({ variables: [tone] })).toEqual([tone]);
    expect(unusedVariables({ variables: [null, { label: { en: 'No name yet' } }] })).toEqual([]);
  });
});

describe('variablesUsedInInstructions', () => {
  test('names the fields any language of the instructions uses', () => {
    const app = {
      system: { en: 'Write for {{audience}}.', de: 'Schreiben Sie im Ton {{tone}}.' },
      prompt: { en: 'Length: {{length}}' },
      variables: [tone, length, audience]
    };

    expect(variablesUsedInInstructions(app)).toEqual(['tone', 'audience']);
  });

  test('a field only the message template uses is not one of them', () => {
    const app = {
      system: { en: 'You summarize.' },
      prompt: { en: '{{length}}' },
      variables: [length]
    };

    expect(variablesUsedInInstructions(app)).toEqual([]);
  });

  test('a placeholder without a field is not listed', () => {
    expect(variablesUsedInInstructions({ system: { en: '{{date}} {{tone}}' } })).toEqual([]);
  });
});

describe('addVariableToTemplate', () => {
  test('appends "<label>: {{name}}" as a line of its own', () => {
    const app = { id: 'x', prompt: { en: '{{content}}' }, variables: [tone] };

    const result = addVariableToTemplate(app, tone, 'en');

    expect(result.prompt).toEqual({ en: '{{content}}\nTone: {{tone}}' });
    expect(unusedVariables(result)).toEqual([]);
  });

  test('uses the label of the language it extends', () => {
    const result = addVariableToTemplate({ prompt: { de: 'Text: {{content}}\n' } }, length, 'de');

    expect(result.prompt.de).toBe('Text: {{content}}\nLänge: {{length}}');
  });

  test('starts a template where the app has none', () => {
    expect(addVariableToTemplate({ id: 'x' }, tone, 'de')).toEqual({
      id: 'x',
      prompt: { de: 'Ton: {{tone}}' }
    });
  });

  test('extends only the given language', () => {
    const app = { prompt: { en: '{{content}}', de: '{{content}}' } };

    expect(addVariableToTemplate(app, tone, 'de').prompt).toEqual({
      en: '{{content}}',
      de: '{{content}}\nTon: {{tone}}'
    });
  });

  test('without a language every language of the template is extended', () => {
    const app = { prompt: { en: '{{content}}', de: 'Ton: {{tone}}\n{{content}}' } };

    expect(addVariableToTemplate(app, tone).prompt).toEqual({
      en: '{{content}}\nTone: {{tone}}',
      de: 'Ton: {{tone}}\n{{content}}'
    });
    expect(addVariableToTemplate({}, length).prompt).toEqual({ en: 'Length: {{length}}' });
  });

  test('a label in another language, or the name, stands in for a missing label', () => {
    expect(addVariableToTemplate({}, audience, 'de').prompt.de).toBe('Audience: {{audience}}');
    expect(addVariableToTemplate({}, { name: 'reading_level' }, 'en').prompt.en).toBe(
      'reading_level: {{reading_level}}'
    );
  });

  test('a label that ends in a colon does not get a second one', () => {
    const field = { name: 'tone', label: { en: 'Tone: ' } };

    expect(addVariableToTemplate({}, field, 'en').prompt.en).toBe('Tone: {{tone}}');
  });

  test('a template that already uses the field is not changed', () => {
    const app = { prompt: { en: 'In a {{tone}} tone: {{content}}' } };

    expect(addVariableToTemplate(app, tone, 'en')).toBe(app);
  });

  test('a field without a name changes nothing', () => {
    const app = { prompt: { en: '{{content}}' } };

    expect(addVariableToTemplate(app, { label: { en: 'Tone' } }, 'en')).toBe(app);
    expect(addVariableToTemplate(app, undefined, 'en')).toBe(app);
  });

  test('does not modify the app', () => {
    const app = { prompt: { en: '{{content}}' }, variables: [tone] };
    const snapshot = JSON.parse(JSON.stringify(app));

    addVariableToTemplate(app, tone, 'en');

    expect(app).toEqual(snapshot);
  });

  test('applied to every unused field, no field is unused afterwards', () => {
    let app = {
      system: { de: 'Schreiben Sie für {{audience}}.' },
      prompt: { de: '{{content}}' },
      variables: [tone, length, audience]
    };

    for (const variable of unusedVariables(app)) {
      app = addVariableToTemplate(app, variable, 'de');
    }

    expect(app.prompt.de).toBe('{{content}}\nTon: {{tone}}\nLänge: {{length}}');
    expect(unusedVariables(app)).toEqual([]);
  });
});

describe('removeVariables', () => {
  test('drops the fields and only the template lines that use them', () => {
    const app = {
      id: 'x',
      system: { en: 'You summarize texts.' },
      prompt: {
        en: 'Summarize the text below.\nLength: {{length}}\nTone: {{tone}}\n\n{{content}}'
      },
      variables: [tone, length]
    };

    expect(removeVariables(app)).toEqual({
      id: 'x',
      system: { en: 'You summarize texts.' },
      prompt: { en: 'Summarize the text below.\n\n{{content}}' },
      variables: []
    });
  });

  test('works on every language of the template', () => {
    const app = {
      prompt: { en: '{{content}}\nTone: {{tone}}', de: 'Ton: {{tone}}\n{{content}}' },
      variables: [tone]
    };

    expect(removeVariables(app).prompt).toEqual({ en: '{{content}}', de: '{{content}}' });
  });

  test('a template that only held field lines goes with them', () => {
    const app = {
      prompt: { en: 'Tone: {{tone}}\nLength: {{length}}', de: '{{content}}\nTon: {{tone}}' },
      variables: [tone, length]
    };

    expect(removeVariables(app).prompt).toEqual({ de: '{{content}}' });
    expect(
      removeVariables({ prompt: { en: 'Tone: {{tone}}' }, variables: [tone] })
    ).not.toHaveProperty('prompt');
  });

  test('a line with another placeholder stays as it is', () => {
    const app = {
      prompt: { en: 'Today is {{date}}.\n  Indented: {{content}}  \nTone: {{tone}}' },
      variables: [tone]
    };

    expect(removeVariables(app).prompt.en).toBe('Today is {{date}}.\n  Indented: {{content}}');
  });

  test('a template no field touches keeps its blank lines and spaces', () => {
    const prompt = { en: '\n{{content}}\n\n\n— end —  ' };

    expect(removeVariables({ prompt, variables: [tone] }).prompt).toEqual(prompt);
  });

  test('the instructions are not touched', () => {
    const system = { en: 'Write in a {{tone}} tone.' };
    const app = { system, prompt: { en: 'Tone: {{tone}}\n{{content}}' }, variables: [tone] };

    expect(removeVariables(app).system).toEqual(system);
    expect(variablesUsedInInstructions(app)).toEqual(['tone']);
  });

  test('an app without fields only gets the empty list', () => {
    expect(removeVariables({ id: 'x', prompt: { en: '{{content}}' } })).toEqual({
      id: 'x',
      prompt: { en: '{{content}}' },
      variables: []
    });
  });

  test('undoes addVariableToTemplate', () => {
    const before = { prompt: { en: 'Summarize:\n{{content}}' }, variables: [tone, length] };
    let app = before;
    for (const variable of before.variables) app = addVariableToTemplate(app, variable, 'en');

    expect(removeVariables(app)).toEqual({ ...before, variables: [] });
  });

  test('does not modify the app', () => {
    const app = { prompt: { en: 'Tone: {{tone}}\n{{content}}' }, variables: [tone] };
    const snapshot = JSON.parse(JSON.stringify(app));

    removeVariables(app);

    expect(app).toEqual(snapshot);
  });
});

describe('placeholderFromLabel', () => {
  test.each([
    ['Reading level', 'reading_level'],
    ['Target language', 'target_language'],
    ['Länge', 'laenge'],
    ['Größe des Textes', 'groesse_des_textes'],
    ['Ton (förmlich / locker)', 'ton_foermlich_locker'],
    ['Zielgruppe:', 'zielgruppe'],
    ['E-Mail', 'e_mail'],
    ['Résumé', 'resume'],
    ['  Tone  ', 'tone'],
    ['1. Entwurf', 'field_1_entwurf'],
    ['2026', 'field_2026']
  ])('%p → %p', (label, expected) => {
    expect(placeholderFromLabel(label)).toBe(expected);
  });

  test.each([['要約'], ['???'], [''], [undefined], [null]])(
    'a label without a usable character (%p) gives "field"',
    label => {
      expect(placeholderFromLabel(label)).toBe('field');
    }
  );

  test('avoids names already taken', () => {
    expect(placeholderFromLabel('Tone', ['tone'])).toBe('tone_2');
    expect(placeholderFromLabel('Tone', ['tone', 'tone_2', 'tone_3'])).toBe('tone_4');
    expect(placeholderFromLabel('Tone', new Set(['length']))).toBe('tone');
    expect(placeholderFromLabel('', ['field'])).toBe('field_2');
  });

  test('never gives "content", the placeholder of the message', () => {
    expect(placeholderFromLabel('Content')).toBe('content_2');
    expect(placeholderFromLabel('Content', ['content_2'])).toBe('content_3');
  });

  test('a long label is cut', () => {
    const name = placeholderFromLabel('The reading level the answer should be written for, please');

    expect(name.length).toBeLessThanOrEqual(40);
    expect(name).toMatch(/[a-z0-9]$/);
    expect(placeholderFromLabel('x'.repeat(40), ['x'.repeat(40)])).toBe(`${'x'.repeat(40)}_2`);
  });

  test('the result always matches the name rule of the app schema and is free', () => {
    const labels = [
      'Reading level',
      'Länge',
      '1. Entwurf',
      '要約',
      '',
      '---',
      '_private_',
      'UPPER case',
      'a'.repeat(120),
      'Tone',
      'tone',
      'Content',
      'Ünïcödé — ¿qué?',
      '100 %'
    ];
    const taken = [];

    for (const label of [...labels, ...labels]) {
      const name = placeholderFromLabel(label, taken);

      expect(name).toMatch(VARIABLE_NAME_PATTERN);
      expect(name).not.toBe('content');
      expect(taken).not.toContain(name);
      // The placeholder the name gives is one the app's texts can carry.
      expect(placeholdersIn(`{{${name}}}`)).toEqual([name]);
      taken.push(name);
    }
  });
});
