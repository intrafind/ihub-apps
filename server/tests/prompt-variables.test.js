/**
 * Prompt variables (#2519): which placeholders a prompt asks for, and how the
 * text reads once they are filled in. The same module drives the client's
 * fill-in form, so what is pinned here is what a user sees.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_AUTO_VARIABLES,
  autoVariableNames,
  buildVariableFields,
  extractVariableNames,
  fillPromptVariables,
  humanizeVariableName,
  initialVariableValues,
  missingRequiredVariables
} from '../../shared/promptVariables.js';

describe('extractVariableNames', () => {
  it('returns each placeholder once, in order of first use', () => {
    assert.deepEqual(
      extractVariableNames('Write a {{tone}} email to {{recipient}} about {{topic}}. {{tone}}!'),
      ['tone', 'recipient', 'topic']
    );
  });

  it('ignores anything that is not a strict placeholder', () => {
    assert.deepEqual(extractVariableNames('{{ spaced }} {{1bad}} {single} [content] {{ok_1-x}}'), [
      'ok_1-x'
    ]);
    assert.deepEqual(extractVariableNames(''), []);
    assert.deepEqual(extractVariableNames(null), []);
  });
});

describe('humanizeVariableName', () => {
  it('turns a name into a label', () => {
    assert.equal(humanizeVariableName('due_date'), 'Due date');
    assert.equal(humanizeVariableName('targetLanguage'), 'Target language');
    assert.equal(humanizeVariableName('x'), 'X');
  });
});

describe('buildVariableFields', () => {
  it('asks for undescribed placeholders as required free text', () => {
    const fields = buildVariableFields('Email {{recipient}} about {{topic}}');
    assert.deepEqual(
      fields.map(f => [f.name, f.type, f.required, f.label, f.declared]),
      [
        ['recipient', 'string', true, 'Recipient', false],
        ['topic', 'string', true, 'Topic', false]
      ]
    );
  });

  it('never asks for global variables or {{content}}', () => {
    const fields = buildVariableFields(
      'Hi, I am {{user_name}}. Today is {{date}}. {{company}} {{recipient}}: {{content}}',
      [],
      { autoNames: autoVariableNames({ company: 'ACME' }) }
    );
    assert.deepEqual(
      fields.map(f => f.name),
      ['recipient']
    );
  });

  it('asks for {{tone}} — the style setting is usually unset', () => {
    assert.ok(!BUILTIN_AUTO_VARIABLES.includes('tone'));
    assert.deepEqual(
      buildVariableFields('A {{tone}} note').map(f => f.name),
      ['tone']
    );
  });

  it('merges declared metadata, and a declared name is asked for even if it is automatic', () => {
    const fields = buildVariableFields('{{tone}} to {{date}}: {{content}}', [
      {
        name: 'tone',
        label: { en: 'Tone' },
        type: 'select',
        required: false,
        defaultValue: 'formal',
        predefinedValues: [{ label: { en: 'Formal' }, value: 'formal' }]
      },
      { name: 'date', type: 'string', required: true },
      { name: 'content', type: 'textarea', required: true }
    ]);
    assert.deepEqual(
      fields.map(f => [f.name, f.type, f.required, f.defaultValue]),
      [
        ['tone', 'select', false, 'formal'],
        ['date', 'string', true, undefined],
        ['content', 'textarea', true, undefined]
      ]
    );
    assert.equal(fields[0].predefinedValues.length, 1);
  });

  it('returns declared-but-unused variables only when asked to', () => {
    const declared = [{ name: 'language', type: 'string' }];
    assert.equal(buildVariableFields('Translate {{content}}', declared).length, 0);
    const withUnused = buildVariableFields('Translate {{content}}', declared, {
      includeUnused: true
    });
    assert.deepEqual(
      withUnused.map(f => [f.name, f.inText]),
      [['language', false]]
    );
  });

  it('drops metadata whose name is not a valid variable name', () => {
    const fields = buildVariableFields('{{a}}', [{ name: '__proto__x y' }, { name: 'a' }]);
    assert.equal(fields.length, 1);
    assert.equal(fields[0].declared, true);
  });
});

describe('initialVariableValues and missingRequiredVariables', () => {
  const fields = buildVariableFields('{{a}} {{b}} {{c}}', [
    { name: 'b', type: 'boolean' },
    { name: 'c', type: 'string', defaultValue: 'hello', required: true }
  ]);

  it('starts from defaults, empty strings and false', () => {
    assert.deepEqual(initialVariableValues(fields), { a: '', b: false, c: 'hello' });
    assert.deepEqual(initialVariableValues(fields, { a: 'x' }).a, 'x');
  });

  it('reports required fields without a value, never a boolean', () => {
    assert.deepEqual(missingRequiredVariables(fields, { a: '  ', b: false, c: 'hi' }), ['a']);
    assert.deepEqual(missingRequiredVariables(fields, { a: 'x', b: false, c: 'hi' }), []);
  });
});

describe('fillPromptVariables', () => {
  it('fills user values and automatic values, and leaves the rest as written', () => {
    const { text, caret } = fillPromptVariables(
      'Dear {{recipient}}, {{date}} {{model_name}} — {{user_name}}',
      { recipient: 'Ada' },
      { autoValues: { date: 'Tuesday', user_name: 'Grace', model_name: '' } }
    );
    assert.equal(text, 'Dear Ada, Tuesday {{model_name}} — Grace');
    assert.equal(caret, null);
  });

  it('takes {{content}} out and puts the caret there', () => {
    const { text, caret } = fillPromptVariables('Summarize the following text: {{content}}');
    assert.equal(text, 'Summarize the following text: ');
    assert.equal(caret, text.length);

    const middle = fillPromptVariables('Translate {{content}} into {{lang}}', { lang: 'German' });
    assert.equal(middle.text, 'Translate  into German');
    assert.equal(middle.caret, 'Translate '.length);
  });

  it('fills a declared {{content}} like any other field', () => {
    assert.equal(fillPromptVariables('Fix: {{content}}', { content: 'teh' }).text, 'Fix: teh');
  });

  it('inserts values literally — never re-expanded, no replacement patterns', () => {
    const { text } = fillPromptVariables(
      '{{a}} {{b}}',
      { a: '{{b}}', b: '$& $1' },
      { autoValues: { b: 'auto' } }
    );
    assert.equal(text, '{{b}} $& $1');
  });

  it('stringifies non-string values', () => {
    assert.equal(fillPromptVariables('{{n}} {{f}}', { n: 3, f: true }).text, '3 true');
  });
});
