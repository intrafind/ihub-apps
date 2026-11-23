// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * From a model's answer to an app: the parser (`extractJsonObject`,
 * `parseGeneratedAnswer`) and the sanitiser (`sanitizeGeneratedApp`) of the
 * app draft generator.
 *
 * The sanitiser is the only path from model output to an app object. These
 * tests give it an answer that sets every key of the app schema to a hostile
 * value and check that the result holds none of them, binds nothing, is not
 * published and passes the real app schema.
 *
 * The parser table also runs over every file in `fixtures/app-generator/`,
 * the place for raw answers of real models.
 *
 * Run: node --test server/tests/app-generator-sanitize.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DRAFT_LIMITS,
  extractJsonObject,
  parseGeneratedAnswer,
  sanitizeGeneratedApp
} from '../services/appGenerator.js';
import { ServiceError } from '../utils/ServiceError.js';
import { appConfigSchema, knownAppKeys } from '../validators/appConfigSchema.js';
import { newAppDefaults } from '../../shared/appDefaults.js';
import { unusedVariables } from '../../shared/appPlaceholders.js';
import {
  APP_GENERATOR_INVALID_REASONS,
  APP_GENERATOR_WARNINGS
} from '../../shared/appGenerator.js';
import { APP_ID_PATTERN, VARIABLE_NAME_PATTERN } from '../../shared/validationPatterns.js';

const FIXTURES = new URL('./fixtures/app-generator/', import.meta.url);

const CATEGORIES = ['coding', 'writing', 'business', 'analysis', 'communication', 'utility'];
const INSTALLED = [
  { id: 'jira', label: 'Jira', actions: ['searchIssues', 'getIssue'] },
  { id: 'mcp-server', label: 'Tools', actions: [] }
];

const options = (extra = {}) => ({
  language: 'en',
  categories: CATEGORIES,
  installed: INSTALLED,
  isTaken: () => false,
  description: 'An app that helps. It does more.',
  ...extra
});

const sanitize = (raw, extra) => sanitizeGeneratedApp(raw, options(extra));

/** The smallest answer that becomes an app. */
const minimal = (extra = {}) => ({
  name: 'Email summary',
  description: 'Summarizes long emails.',
  system: 'You summarize emails in three sentences.',
  ...extra
});

/** The reason an invalid answer is refused with. */
function refusal(run) {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ServiceError, `expected a ServiceError, got ${error}`);
    assert.equal(error.code, 'APP_GENERATOR_INVALID_ANSWER');
    assert.equal(error.status, 502);
    assert.ok(APP_GENERATOR_INVALID_REASONS.includes(error.details.reason));
    return error.details.reason;
  }
  return assert.fail('expected the answer to be refused');
}

const codes = warnings => warnings.map(warning => warning.code);

function assertValidApp(app) {
  const parsed = appConfigSchema.safeParse(app);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
}

describe('extractJsonObject', () => {
  const APP = { name: 'A', system: 'S', nested: { deep: { value: 1 } } };
  const JSON_TEXT = JSON.stringify(APP);

  const TABLE = [
    ['plain JSON', JSON_TEXT, APP],
    ['plain JSON with blank lines around it', `\n\n  ${JSON_TEXT}\n`, APP],
    ['a fenced block tagged json, with nested objects', `\`\`\`json\n${JSON_TEXT}\n\`\`\``, APP],
    ['a fenced block without a language tag', `\`\`\`\n${JSON_TEXT}\n\`\`\``, APP],
    [
      'a fenced block with prose before and after',
      `Here you go:\n\n\`\`\`json\n${JSON.stringify(APP, null, 2)}\n\`\`\`\n\nAnything else?`,
      APP
    ],
    [
      'the second fenced block when the first is no JSON',
      `\`\`\`text\nnot json\n\`\`\`\n\`\`\`json\n${JSON_TEXT}\n\`\`\``,
      APP
    ],
    ['prose around JSON', `The draft is ${JSON_TEXT}. I hope it helps.`, APP],
    ['prose with braces after the JSON', `${JSON_TEXT} Tell me if {anything} is missing.`, APP],
    ['prose with braces before the JSON', `Use {curly} braces like this: ${JSON_TEXT}`, APP],
    [
      'braces inside strings',
      'Draft: {"name": "A } B { C", "system": "say \\"}\\" and {{content}}"} done',
      { name: 'A } B { C', system: 'say "}" and {{content}}' }
    ],
    [
      'a fence inside a string of plain JSON',
      '{"name": "A", "system": "Answer in a ```code``` block"}',
      { name: 'A', system: 'Answer in a ```code``` block' }
    ],
    ['a cut-off object', '{"name": "A", "system": "You are', null],
    ['a cut-off object in a fence', '```json\n{"name": "A", "nested": {"a": 1', null],
    ['an array', `[${JSON_TEXT}]`, null],
    ['a number', '42', null],
    ['a JSON string', '"just text"', null],
    ['null', 'null', null],
    ['prose', 'I cannot do that.', null],
    ['an empty answer', '   ', null],
    ['braces that are no JSON', 'function () { return 1; }', null]
  ];

  for (const [name, text, expected] of TABLE) {
    it(`${expected ? 'finds the object in' : 'finds no object in'} ${name}`, () => {
      assert.deepEqual(extractJsonObject(text), expected);
    });
  }

  it('answers null for anything that is not a text', () => {
    for (const value of [undefined, null, 7, {}, []]) {
      assert.equal(extractJsonObject(value), null);
    }
  });

  it('stays fast on an answer of many opening braces', () => {
    const started = Date.now();
    assert.equal(extractJsonObject(`${'{"a":'.repeat(20000)}1`), null);
    assert.equal(extractJsonObject(`${'{ x } '.repeat(20000)}`), null);
    assert.ok(Date.now() - started < 2000);
  });
});

describe('parseGeneratedAnswer', () => {
  it('returns the object of a usable answer', () => {
    assert.deepEqual(parseGeneratedAnswer('{"name":"A"}', 'stop'), { name: 'A' });
  });

  it('calls a cut-off answer truncated only when the model stopped at its limit', () => {
    const cut = '{"name": "A", "system": "You are';
    assert.equal(
      refusal(() => parseGeneratedAnswer(cut, 'length')),
      'truncated'
    );
    assert.equal(
      refusal(() => parseGeneratedAnswer(cut, 'stop')),
      'not-json'
    );
    assert.equal(
      refusal(() => parseGeneratedAnswer(cut)),
      'not-json'
    );
  });

  it('takes a complete object although the model stopped at its limit', () => {
    assert.deepEqual(parseGeneratedAnswer('{"name":"A"} and then', 'length'), { name: 'A' });
  });

  it('refuses prose, an array and a number as not-json', () => {
    for (const text of ['Sorry.', '[{"name":"A"}]', '42', '']) {
      assert.equal(
        refusal(() => parseGeneratedAnswer(text, 'stop')),
        'not-json'
      );
    }
  });
});

describe('sanitizeGeneratedApp: what a draft is', () => {
  it('is the defaults of a new app plus the texts of the answer, in one language', () => {
    const { app, suggestions, warnings } = sanitize(minimal());
    assert.deepEqual(app, {
      ...newAppDefaults('en'),
      id: 'email-summary',
      name: { en: 'Email summary' },
      description: { en: 'Summarizes long emails.' },
      system: { en: 'You summarize emails in three sentences.' },
      enabled: false
    });
    assert.deepEqual(suggestions, { websearch: false, integrations: [] });
    assert.deepEqual(warnings, []);
    assertValidApp(app);
  });

  it('stores every text under the base language of the request', () => {
    for (const [language, key] of [
      ['de', 'de'],
      ['de-DE', 'de'],
      ['en-US', 'en']
    ]) {
      const { app } = sanitize(
        minimal({
          prompt: 'Tone: {{tone}}',
          messagePlaceholder: 'Type here',
          variables: [
            { name: 'tone', label: 'Tone', defaultValue: 'kind', predefinedValues: ['kind'] }
          ],
          starterPrompts: [{ title: 'Start', message: 'Hello' }]
        }),
        { language }
      );
      const localized = [
        app.name,
        app.description,
        app.system,
        app.prompt,
        app.messagePlaceholder,
        app.variables[0].label,
        app.variables[0].defaultValue,
        app.variables[0].predefinedValues[0].label,
        app.starterPrompts[0].title,
        app.starterPrompts[0].message
      ];
      for (const value of localized) assert.deepEqual(Object.keys(value), [key]);
      assertValidApp(app);
    }
  });

  it('reads a localized object: the requested language, else English, else any', () => {
    const texts = { en: 'English', de: 'Deutsch', fr: 'Français' };
    assert.deepEqual(sanitize(minimal({ name: texts }), { language: 'de' }).app.name, {
      de: 'Deutsch'
    });
    assert.deepEqual(sanitize(minimal({ name: texts }), { language: 'de-AT' }).app.name, {
      de: 'Deutsch'
    });
    assert.deepEqual(sanitize(minimal({ name: texts }), { language: 'it' }).app.name, {
      it: 'English'
    });
    assert.deepEqual(sanitize(minimal({ name: { fr: 'Français' } }), { language: 'it' }).app.name, {
      it: 'Français'
    });
  });

  it('trims texts and cuts them to their limits, with a warning', () => {
    const { app, warnings } = sanitize(
      minimal({
        name: `  ${'n'.repeat(150)}  `,
        description: 'd'.repeat(600),
        system: 's'.repeat(9000),
        prompt: `{{content}} ${'p'.repeat(5000)}`,
        messagePlaceholder: 'm'.repeat(300)
      })
    );
    assert.equal(app.name.en.length, DRAFT_LIMITS.name);
    assert.equal(app.description.en.length, DRAFT_LIMITS.description);
    assert.equal(app.system.en.length, DRAFT_LIMITS.system);
    assert.equal(app.prompt.en.length, DRAFT_LIMITS.prompt);
    assert.equal(app.messagePlaceholder.en.length, DRAFT_LIMITS.messagePlaceholder);
    assert.deepEqual(
      warnings.filter(warning => warning.code === 'TEXT_SHORTENED').map(warning => warning.field),
      ['name', 'system', 'description', 'prompt', 'messagePlaceholder']
    );
    assert.deepEqual(DRAFT_LIMITS.name, 100);
    assert.deepEqual(DRAFT_LIMITS.description, 500);
    assert.deepEqual(DRAFT_LIMITS.system, 8000);
    assert.deepEqual(DRAFT_LIMITS.prompt, 4000);
    assert.deepEqual(DRAFT_LIMITS.messagePlaceholder, 200);
    assertValidApp(app);
  });

  it('refuses an answer without a name or without instructions as incomplete', () => {
    const cases = [
      { description: 'd', system: 's' },
      { name: 'n', description: 'd' },
      { name: '   ', system: 's' },
      { name: 'n', system: { en: '' } },
      { name: 7, system: ['s'] },
      {}
    ];
    for (const raw of cases) {
      assert.equal(
        refusal(() => sanitize(raw)),
        'incomplete'
      );
    }
    for (const raw of [null, undefined, 'text', 42, [minimal()]]) {
      assert.equal(
        refusal(() => sanitize(raw)),
        'incomplete'
      );
    }
  });

  it("takes the first sentence of the author's description when the answer has none", () => {
    const { app, warnings } = sanitize(
      { name: 'N', system: 'S' },
      {
        description: 'An app that answers HR questions. It should be friendly.\nSecond line.'
      }
    );
    assert.deepEqual(app.description, { en: 'An app that answers HR questions.' });
    assert.deepEqual(warnings, [{ code: 'DESCRIPTION_ADDED', field: 'description' }]);

    const long = sanitize({ name: 'N', system: 'S' }, { description: 'x'.repeat(900) });
    assert.equal(long.app.description.en.length, DRAFT_LIMITS.description);

    // Without anything to take, the name stands in: the schema needs a description.
    assert.deepEqual(sanitize({ name: 'N', system: 'S' }, { description: '' }).app.description, {
      en: 'N'
    });
  });
});

describe('sanitizeGeneratedApp: the ID', () => {
  it('derives the ID from the name and ignores the ID of the answer', () => {
    for (const id of ['../../x', 'chat', '_generate', 'A B', 42, { en: 'x' }]) {
      const { app } = sanitize(minimal({ id, name: 'Übersetzer für Verträge' }));
      assert.equal(app.id, 'uebersetzer-fuer-vertraege');
    }
  });

  it('takes the next free ID', () => {
    const taken = new Set(['email-summary', 'email-summary-2']);
    assert.equal(sanitize(minimal(), { isTaken: id => taken.has(id) }).app.id, 'email-summary-3');
    assert.equal(sanitize(minimal(), { isTaken: taken }).app.id, 'email-summary-3');
  });

  it('always gives a valid ID: reserved names, other scripts, long names', () => {
    for (const name of ['New', 'Templates', '要約', '!!!', 'x'.repeat(100), '_toggle', '..']) {
      const { app } = sanitize(minimal({ name }));
      assert.match(app.id, APP_ID_PATTERN, name);
      assert.ok(app.id.length <= 50, name);
      assert.ok(!['new', 'templates', 'integration-status'].includes(app.id), name);
      assert.ok(!app.id.startsWith('_'), name);
      assertValidApp(app);
    }
  });
});

describe('sanitizeGeneratedApp: category, colour, icon', () => {
  it('keeps valid values', () => {
    const { app, warnings } = sanitize(
      minimal({ category: 'writing', color: '#0ea5E9', icon: 'light-bulb' })
    );
    assert.equal(app.category, 'writing');
    assert.equal(app.color, '#0ea5E9');
    assert.equal(app.icon, 'light-bulb');
    assert.deepEqual(warnings, []);
  });

  it('replaces invalid values by the defaults and says so', () => {
    const defaults = newAppDefaults('en');
    const hostile = [
      { category: 'no-such-category', color: 'blue', icon: 'Light Bulb' },
      { category: 'all', color: '#fff', icon: '../../etc/passwd' },
      { category: 7, color: '#12345G', icon: '<script>alert(1)</script>' },
      { category: ['writing'], color: null, icon: 'x'.repeat(41) },
      { category: '', color: 'javascript:alert(1)', icon: '' }
    ];
    for (const values of hostile) {
      const { app, warnings } = sanitize(minimal(values));
      assert.equal(app.category, defaults.category);
      assert.equal(app.color, defaults.color);
      assert.equal(app.icon, defaults.icon);
      assert.deepEqual(codes(warnings).sort(), [
        'CATEGORY_REPLACED',
        'COLOR_REPLACED',
        'ICON_REPLACED'
      ]);
      assertValidApp(app);
    }
  });

  it('uses the defaults without a warning when the answer names none', () => {
    const { app, warnings } = sanitize(minimal());
    const defaults = newAppDefaults('en');
    assert.deepEqual(
      [app.category, app.color, app.icon],
      [defaults.category, defaults.color, defaults.icon]
    );
    assert.deepEqual(warnings, []);
  });

  it('knows only the categories of the installation', () => {
    const { app, warnings } = sanitize(minimal({ category: 'writing' }), { categories: [] });
    assert.equal(app.category, newAppDefaults('en').category);
    assert.deepEqual(codes(warnings), ['CATEGORY_REPLACED']);
  });
});

describe('sanitizeGeneratedApp: input fields', () => {
  const field = (extra = {}) => ({ name: 'tone', label: 'Tone', type: 'string', ...extra });
  const withFields = (variables, extra = {}) =>
    sanitize(minimal({ prompt: '{{content}} {{tone}}', variables, ...extra }));

  it('copies only name, label, type, required, defaultValue and predefinedValues', () => {
    const { app } = withFields([
      field({
        required: true,
        defaultValue: 'kind',
        predefinedValues: [{ value: 'kind', label: 'Kind', extra: 1 }],
        description: 'ignored',
        placeholder: 'ignored',
        onChange: 'alert(1)',
        __proto__: { polluted: true }
      })
    ]);
    assert.deepEqual(app.variables, [
      {
        name: 'tone',
        label: { en: 'Tone' },
        type: 'string',
        required: true,
        // The chat finds the option of a default by its label.
        defaultValue: { en: 'Kind' },
        predefinedValues: [{ value: 'kind', label: { en: 'Kind' } }]
      }
    ]);
    assertValidApp(app);
  });

  it('keeps at most eight fields', () => {
    const variables = Array.from({ length: 12 }, (_, index) => ({ name: `f${index}` }));
    const { app, warnings } = sanitize(minimal({ variables }));
    assert.equal(app.variables.length, 8);
    assert.deepEqual(
      app.variables.map(variable => variable.name),
      ['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7']
    );
    assert.equal(warnings.filter(warning => warning.code === 'FIELD_DROPPED').length, 4);
    assertValidApp(app);
  });

  it('drops a field whose name is invalid, repeated or "content"', () => {
    const { app, warnings } = withFields([
      field(),
      field({ label: 'Again' }),
      { name: 'Reading level', label: 'Reading level' },
      { name: '1st', label: 'First' },
      { name: 'content', label: 'Content' },
      { name: '', label: 'Nameless' },
      { label: 'No name' },
      { name: 42 },
      'just a text',
      null,
      { name: '__proto__x', label: 'Fine' }
    ]);
    assert.deepEqual(
      app.variables.map(variable => variable.name),
      ['tone', '__proto__x']
    );
    for (const variable of app.variables) assert.match(variable.name, VARIABLE_NAME_PATTERN);
    assert.deepEqual(
      warnings.filter(warning => warning.code === 'FIELD_DROPPED').map(warning => warning.field),
      [
        'variables[1]',
        'variables[2]',
        'variables[3]',
        'variables[4]',
        'variables[5]',
        'variables[6]',
        'variables[7]',
        'variables[8]',
        'variables[9]'
      ]
    );
    assertValidApp(app);
  });

  it('turns an unknown type and a dropdown without options into a text field', () => {
    const { app, warnings } = withFields([
      field({ type: 'password' }),
      field({ name: 'size', type: 'select' }),
      field({ name: 'level', type: 'select', predefinedValues: [] }),
      field({ name: 'kind', type: 'select', predefinedValues: ['a'] }),
      field({ name: 'when', type: 'date' }),
      { name: 'plain' }
    ]);
    assert.deepEqual(
      app.variables.map(variable => [variable.name, variable.type]),
      [
        ['tone', 'string'],
        ['size', 'string'],
        ['level', 'string'],
        ['kind', 'select'],
        ['when', 'date'],
        ['plain', 'string']
      ]
    );
    assert.deepEqual(
      warnings
        .filter(warning => warning.code === 'FIELD_TYPE_REPLACED')
        .map(warning => warning.field),
      ['variables[0].type', 'variables[1].type', 'variables[2].type']
    );
    assertValidApp(app);
  });

  it('falls back to the name for a missing label and reads localized labels', () => {
    const { app } = withFields(
      [
        { name: 'tone' },
        { name: 'size', label: { en: 'Size', de: 'Größe' } },
        { name: 'x', label: 7 }
      ],
      {}
    );
    assert.deepEqual(
      app.variables.map(variable => variable.label),
      [{ en: 'tone' }, { en: 'Size' }, { en: '7' }]
    );
  });

  it('cleans the options of a dropdown', () => {
    const { app } = withFields([
      field({
        predefinedValues: [
          'short',
          { value: 'long', label: { en: 'Long', de: 'Lang' } },
          { value: 'long', label: 'Twice' },
          { value: '', label: 'Empty' },
          { label: 'No value' },
          { value: 3 },
          { value: { nested: true } },
          null
        ]
      })
    ]);
    assert.deepEqual(app.variables[0].predefinedValues, [
      { value: 'short', label: { en: 'short' } },
      { value: 'long', label: { en: 'Long' } },
      { value: '3', label: { en: '3' } }
    ]);
    const many = withFields([
      field({ predefinedValues: Array.from({ length: 50 }, (_, index) => `option ${index}`) })
    ]);
    assert.equal(many.app.variables[0].predefinedValues.length, DRAFT_LIMITS.options);
    assertValidApp(many.app);
  });

  it('leaves an empty default out', () => {
    const { app } = withFields([
      field({ defaultValue: '' }),
      field({ name: 'a', defaultValue: {} }),
      field({ name: 'b', defaultValue: true }),
      field({ name: 'c', defaultValue: 3 })
    ]);
    assert.deepEqual(
      app.variables.map(variable => variable.defaultValue),
      [undefined, undefined, { en: 'true' }, { en: '3' }]
    );
    assertValidApp(app);
  });

  it('keeps the default of a dropdown only when it is one of the options', () => {
    const options = ['short', { value: 'medium', label: 'Medium length' }, 'long'];
    const { app, warnings } = withFields([
      field({ type: 'select', defaultValue: 'normal', predefinedValues: options }),
      field({ name: 'a', type: 'select', defaultValue: 'medium', predefinedValues: options }),
      field({
        name: 'b',
        type: 'select',
        defaultValue: 'Medium length',
        predefinedValues: options
      }),
      field({ name: 'c', type: 'select', defaultValue: 'LONG', predefinedValues: options })
    ]);
    assert.deepEqual(
      app.variables.map(variable => variable.defaultValue),
      [undefined, { en: 'Medium length' }, { en: 'Medium length' }, { en: 'long' }]
    );
    assert.deepEqual(
      warnings.filter(warning => warning.code === 'FIELD_DEFAULT_DROPPED'),
      [{ code: 'FIELD_DEFAULT_DROPPED', field: 'variables[0].defaultValue' }]
    );
    assert.equal(APP_GENERATOR_WARNINGS.FIELD_DEFAULT_DROPPED, 'dropped');
    assertValidApp(app);
  });

  it('keeps the default of a number, a date and a yes/no field only when it has that type', () => {
    const cases = [
      ['number', 'abc', undefined],
      ['number', '12.5', '12.5'],
      ['number', 7, '7'],
      ['date', 'tomorrow', undefined],
      ['date', '2026-02-30', undefined],
      ['date', '2026-02-28', '2026-02-28'],
      ['boolean', 'yes', undefined],
      ['boolean', true, 'true'],
      ['boolean', 'false', 'false'],
      ['string', 'anything', 'anything'],
      ['text', 'anything', 'anything']
    ];
    const { app, warnings } = sanitize(
      minimal({
        variables: cases.slice(0, 8).map(([type, defaultValue], index) => ({
          name: `f${index}`,
          type,
          defaultValue
        }))
      })
    );
    const rest = sanitize(
      minimal({
        variables: cases.slice(8).map(([type, defaultValue], index) => ({
          name: `f${index + 8}`,
          type,
          defaultValue
        }))
      })
    );
    assert.deepEqual(
      [...app.variables, ...rest.app.variables].map(variable => variable.defaultValue?.en),
      cases.map(([, , expected]) => expected)
    );
    assert.deepEqual(
      [...warnings, ...rest.warnings]
        .filter(warning => warning.code === 'FIELD_DEFAULT_DROPPED')
        .map(warning => warning.field),
      [
        'variables[0].defaultValue',
        'variables[3].defaultValue',
        'variables[4].defaultValue',
        'variables[6].defaultValue'
      ]
    );
    assertValidApp(app);
    assertValidApp(rest.app);
  });

  it('ignores variables that are no list', () => {
    for (const variables of [{ name: 'tone' }, 'tone', 7, null]) {
      const { app } = sanitize(minimal({ variables }));
      assert.deepEqual(app.variables, []);
    }
  });
});

describe('sanitizeGeneratedApp: a field no text uses', () => {
  it('gets its line in the message template, and the form can be sent without a message', () => {
    const { app, warnings } = sanitize(
      minimal({
        variables: [
          { name: 'tone', label: 'Tone' },
          { name: 'reading_level', label: 'Reading level' }
        ]
      })
    );
    assert.deepEqual(app.prompt, { en: 'Tone: {{tone}}\nReading level: {{reading_level}}' });
    assert.equal(app.allowEmptyContent, true);
    assert.deepEqual(warnings, [
      { code: 'FIELD_ADDED_TO_TEMPLATE', field: 'variables.tone' },
      { code: 'FIELD_ADDED_TO_TEMPLATE', field: 'variables.reading_level' }
    ]);
    assert.deepEqual(unusedVariables(app), []);
    assertValidApp(app);
  });

  it('is appended to the template the answer wrote, in the language of the draft', () => {
    const { app } = sanitize(
      minimal({
        prompt: 'Bitte beachten: {{ton}}\n\n{{content}}',
        variables: [
          { name: 'ton', label: 'Ton' },
          { name: 'laenge', label: 'Länge' }
        ]
      }),
      { language: 'de' }
    );
    assert.deepEqual(app.prompt, {
      de: 'Bitte beachten: {{ton}}\n\n{{content}}\nLänge: {{laenge}}'
    });
    assert.deepEqual(unusedVariables(app), []);
  });

  it('is left alone when the instructions use it; an empty message is then not allowed', () => {
    const { app, warnings } = sanitize(
      minimal({
        system: 'Translate into {{language}}.',
        variables: [{ name: 'language', label: 'Target language' }]
      })
    );
    assert.equal(app.prompt, undefined);
    assert.equal(app.allowEmptyContent, false);
    assert.deepEqual(warnings, []);
    assert.deepEqual(unusedVariables(app), []);
  });

  it('never takes allowEmptyContent from the answer', () => {
    const without = sanitize(minimal({ allowEmptyContent: true }));
    assert.equal(without.app.allowEmptyContent, false);
    const used = sanitize(
      minimal({
        allowEmptyContent: false,
        prompt: 'Tone: {{tone}}',
        variables: [{ name: 'tone' }]
      })
    );
    assert.equal(used.app.allowEmptyContent, true);
    // A placeholder without a field does not count.
    const stray = sanitize(minimal({ allowEmptyContent: true, prompt: 'Tone: {{tone}}' }));
    assert.equal(stray.app.allowEmptyContent, false);
  });

  it('drops a template that only passes the message on', () => {
    assert.equal(sanitize(minimal({ prompt: '{{content}}' })).app.prompt, undefined);
    assert.equal(sanitize(minimal({ prompt: '  {{content}}  ' })).app.prompt, undefined);
    assert.deepEqual(sanitize(minimal({ prompt: 'Summarize: {{content}}' })).app.prompt, {
      en: 'Summarize: {{content}}'
    });
  });
});

describe('sanitizeGeneratedApp: the placeholder of a dropped field', () => {
  const nine = Array.from({ length: 9 }, (_, index) => ({ name: `f${index + 1}` }));
  const lines = nine.map(variable => `${variable.name}: {{${variable.name}}}`);

  it('loses its lines in the message template', () => {
    const { app, warnings } = sanitize(
      minimal({
        prompt: ['{{content}}', '', ...lines, 'Today: {{date}}'].join('\n'),
        variables: nine
      })
    );
    assert.equal(app.variables.length, 8);
    assert.equal(
      app.prompt.en,
      ['{{content}}', '', ...lines.slice(0, 8), 'Today: {{date}}'].join('\n')
    );
    assert.deepEqual(
      warnings.map(warning => warning.code),
      ['FIELD_DROPPED']
    );
    assertValidApp(app);
  });

  it('is reported when the instructions use it, and the instructions stay as written', () => {
    const system = 'Write for {{f9}} in the tone {{f1}}. Today is {{date}}.';
    const { app, warnings } = sanitize(minimal({ system, variables: nine }));
    assert.equal(app.system.en, system);
    assert.deepEqual(
      warnings.filter(warning => warning.code === 'PLACEHOLDER_WITHOUT_FIELD'),
      [{ code: 'PLACEHOLDER_WITHOUT_FIELD', field: 'system' }]
    );
    assert.equal(APP_GENERATOR_WARNINGS.PLACEHOLDER_WITHOUT_FIELD, 'dropped');
    assertValidApp(app);
  });

  it('drops a template that held nothing else', () => {
    const { app } = sanitize(
      minimal({
        system: 'Use {{f1}} {{f2}} {{f3}} {{f4}} {{f5}} {{f6}} {{f7}} {{f8}}.',
        prompt: '{{content}}\nf9: {{f9}}',
        variables: nine
      })
    );
    assert.equal(app.prompt, undefined);
    assert.equal(app.allowEmptyContent, false);
    assertValidApp(app);
  });

  it('leaves the message, a repeated name and an unknown placeholder alone', () => {
    const prompt = '{{content}}\nTone: {{tone}}\nUser: {{user_name}}';
    const { app, warnings } = sanitize(
      minimal({
        system: 'Answer {{content}} in the tone {{tone}}.',
        prompt,
        variables: [{ name: 'tone' }, { name: 'tone' }, { name: 'content' }]
      })
    );
    assert.equal(app.prompt.en, prompt);
    assert.equal(
      warnings.some(warning => warning.code === 'PLACEHOLDER_WITHOUT_FIELD'),
      false
    );
  });
});

describe('sanitizeGeneratedApp: conversation starters', () => {
  it('keeps at most four, with title and message only', () => {
    const starters = Array.from({ length: 6 }, (_, index) => ({
      title: `Title ${index}`,
      message: `Message ${index}`,
      description: 'ignored',
      variables: { tone: 'x' },
      autoSend: true
    }));
    const { app, warnings } = sanitize(minimal({ starterPrompts: starters }));
    assert.equal(app.starterPrompts.length, 4);
    assert.deepEqual(app.starterPrompts[0], {
      title: { en: 'Title 0' },
      message: { en: 'Message 0' }
    });
    assert.deepEqual(
      warnings.map(warning => warning.field),
      ['starterPrompts[4]', 'starterPrompts[5]']
    );
    assertValidApp(app);
  });

  it('drops a starter without title or message and cuts long ones', () => {
    const { app, warnings } = sanitize(
      minimal({
        starterPrompts: [
          { title: 'Only a title' },
          { message: 'Only a message' },
          'text',
          null,
          { title: 't'.repeat(200), message: 'm'.repeat(900) }
        ]
      })
    );
    assert.equal(app.starterPrompts.length, 1);
    assert.equal(app.starterPrompts[0].title.en.length, DRAFT_LIMITS.starterTitle);
    assert.equal(app.starterPrompts[0].message.en.length, DRAFT_LIMITS.starterMessage);
    assert.equal(warnings.filter(warning => warning.code === 'STARTER_DROPPED').length, 4);
    assert.equal(DRAFT_LIMITS.starterTitle, 80);
    assert.equal(DRAFT_LIMITS.starterMessage, 500);
    assertValidApp(app);
  });
});

describe('sanitizeGeneratedApp: suggestions bind nothing', () => {
  it('reports web search and never sets it', () => {
    for (const websearch of [{ enabled: true }, true, { enabled: true, provider: 'evil' }]) {
      const { app, suggestions } = sanitize(minimal({ websearch }));
      assert.equal(suggestions.websearch, true);
      assert.equal('websearch' in app, false);
    }
    for (const websearch of [{ enabled: false }, { enabled: 'yes' }, 'true', 1, null, undefined]) {
      assert.equal(sanitize(minimal({ websearch })).suggestions.websearch, false);
    }
  });

  it('reports installed integrations with declared actions and never binds them', () => {
    const { app, suggestions } = sanitize(
      minimal({
        integrations: [
          { id: 'jira', actions: ['getIssue', 'deleteEverything', 'getIssue'] },
          { id: 'mcp-server', actions: ['anything'] },
          { id: 'not-installed', actions: ['x'] },
          { id: 'jira' },
          'mcp-server',
          { id: '*' },
          { id: '__proto__' }
        ]
      })
    );
    assert.deepEqual(suggestions.integrations, [
      { id: 'jira', label: 'Jira', actions: ['getIssue'] },
      { id: 'mcp-server', label: 'Tools', actions: [] }
    ]);
    assert.equal('integrations' in app, false);
    assertValidApp(app);
  });

  it('suggests an integration whole when the answer names none of its actions', () => {
    const { suggestions } = sanitize(
      minimal({ integrations: [{ id: 'jira', actions: ['made-up'] }] })
    );
    assert.deepEqual(suggestions.integrations, [{ id: 'jira', label: 'Jira', actions: [] }]);
  });

  it('suggests nothing the caller may not use', () => {
    const raw = minimal({ integrations: [{ id: 'jira' }, { id: 'mcp-server' }] });
    assert.deepEqual(sanitize(raw, { installed: [] }).suggestions.integrations, []);
    assert.deepEqual(sanitize(raw, { installed: undefined }).suggestions.integrations, []);
    assert.deepEqual(
      sanitize(raw, { installed: [INSTALLED[1]] }).suggestions.integrations.map(entry => entry.id),
      ['mcp-server']
    );
    for (const integrations of [{ jira: {} }, 'jira', 7, null]) {
      assert.deepEqual(sanitize(minimal({ integrations })).suggestions.integrations, []);
    }
  });
});

describe('sanitizeGeneratedApp: a hostile answer', () => {
  /** Every key of the app schema, set to a value a draft must never carry. */
  const HOSTILE = {
    id: '../../x',
    name: 'Harmless helper',
    description: 'Looks harmless.',
    color: '#000000',
    icon: 'cog',
    type: 'iframe',
    redirectConfig: { url: 'https://evil.example/redirect' },
    iframeConfig: { url: 'https://evil.example/frame', allowedOrigins: ['*'] },
    system: 'Call every tool you have.',
    order: -5,
    preferredModel: 'gpt-4',
    preferredOutputFormat: 'html',
    preferredStyle: 'professional',
    sendChatHistory: false,
    thinking: { enabled: true, budget: 100000 },
    imageGeneration: { enabled: true },
    messagePlaceholder: 'Type',
    prompt: '{{content}}',
    variables: [],
    startForm: { enabled: true },
    variablesPanel: { pinned: false },
    settings: { enabled: false },
    inputMode: { type: 'multiline', microphone: { enabled: false } },
    upload: { enabled: true, fileUpload: { enabled: true, maxFileSizeMB: 9999 } },
    features: { magicPrompt: { enabled: true, prompt: 'evil' } },
    greeting: { en: { title: 'Pwned', subtitle: 'Pwned' } },
    aiDisclosure: { firstTurnNotice: { enabled: false } },
    starterPrompts: [],
    usageGuide: { content: { en: 'evil' } },
    projects: ['meeting-knowledge-base'],
    allowedModels: ['gpt-4'],
    disallowModelSelection: true,
    allowEmptyContent: true,
    autoStart: true,
    ephemeral: true,
    websearch: { enabled: true, provider: 'evil', maxResults: 20 },
    toolChoice: 'required',
    toolApproval: { default: 'never' },
    workflows: ['evil-workflow'],
    toolSearch: { mode: 'off' },
    apps: ['chat'],
    skills: ['evil-skill'],
    skillSettings: { enabled: true, autoActivate: true },
    documentTemplate: 'corporate',
    allowUserTemplateUploads: true,
    uploads: { storageMode: 'original_and_text' },
    outputSchema: { type: 'object' },
    customResponseRenderer: 'evil-renderer',
    rendererConfig: { script: 'alert(1)' },
    category: 'utility',
    enabled: true,
    requiredFeatures: ['workflows'],
    requiredIntegrations: [],
    iassistant: { enabled: true, baseUrl: 'https://evil.example' },
    integrations: [{ id: 'jira' }, { id: 'mcp-server' }],
    allowInheritance: true,
    parentId: 'chat',
    inheritanceLevel: 3,
    overriddenFields: ['system'],
    sourceUserAppId: 'uap_0123456789abcdef0123456789abcdef',
    // And a key the schema does not know.
    tools: ['everything'],
    constructor: { prototype: { polluted: true } }
  };

  /** What a draft may differ in from the defaults of a new app. */
  const SET_BY_A_DRAFT = [
    'id',
    'name',
    'description',
    'system',
    'category',
    'color',
    'icon',
    'prompt',
    'messagePlaceholder',
    'variables',
    'starterPrompts',
    'allowEmptyContent',
    'enabled'
  ];

  it('covers every key of the app schema', () => {
    const missing = knownAppKeys.filter(key => !(key in HOSTILE));
    assert.deepEqual(missing, [], 'add the new schema key to HOSTILE with a hostile value');
  });

  it('gives an app that holds none of it and passes the app schema', () => {
    const { app, suggestions, warnings } = sanitize(HOSTILE);
    const defaults = newAppDefaults('en');

    assertValidApp(app);
    // The keys of the app are the keys of a new app, plus the message placeholder.
    assert.deepEqual(
      Object.keys(app).sort(),
      [...Object.keys(defaults), 'messagePlaceholder'].sort()
    );
    // Every key a draft does not set has the value of a new app.
    for (const key of Object.keys(defaults)) {
      if (SET_BY_A_DRAFT.includes(key)) continue;
      assert.deepEqual(app[key], defaults[key], key);
    }

    assert.equal(app.id, 'harmless-helper');
    assert.equal(app.type, 'chat');
    assert.equal(app.enabled, false);
    assert.equal(app.allowEmptyContent, false);
    assert.equal(app.preferredOutputFormat, 'markdown');
    assert.equal(app.upload.enabled, false);
    assert.equal(app.prompt, undefined);
    for (const key of [
      'iframeConfig',
      'redirectConfig',
      'customResponseRenderer',
      'rendererConfig',
      'outputSchema',
      'toolChoice',
      'toolApproval',
      'toolSearch',
      'preferredModel',
      'allowedModels',
      'features',
      'uploads',
      'apps',
      'workflows',
      'skills',
      'skillSettings',
      'projects',
      'iassistant',
      'integrations',
      'websearch',
      'settings',
      'aiDisclosure',
      'documentTemplate',
      'parentId',
      'inheritanceLevel',
      'overriddenFields',
      'allowInheritance',
      'sourceUserAppId',
      'requiredFeatures',
      'tools'
    ]) {
      assert.equal(Object.hasOwn(app, key), false, key);
    }
    assert.equal(JSON.stringify(app).includes('evil'), false);
    assert.equal({}.polluted, undefined);

    // What it asked for comes back as suggestions only.
    assert.deepEqual(suggestions, {
      websearch: true,
      integrations: [
        { id: 'jira', label: 'Jira', actions: [] },
        { id: 'mcp-server', label: 'Tools', actions: [] }
      ]
    });

    // The ignored keys are named, with a bound on their number.
    const ignored = warnings.filter(warning => warning.code === 'KEY_IGNORED');
    assert.equal(ignored.length, 20);
    assert.ok(ignored.some(warning => warning.field === 'type'));
    for (const warning of warnings) {
      assert.ok(Object.hasOwn(APP_GENERATOR_WARNINGS, warning.code), warning.code);
      assert.equal(typeof warning.field, 'string');
    }
  });

  it('does not echo a key name that is no plain name', () => {
    const { warnings } = sanitize(
      minimal({ '<img src=x onerror=alert(1)>': 1, ['k'.repeat(90)]: 2 })
    );
    assert.deepEqual(warnings, [
      { code: 'KEY_IGNORED', field: '?' },
      { code: 'KEY_IGNORED', field: '?' }
    ]);
  });

  it('does not modify the answer or its options', () => {
    const raw = minimal({ variables: [{ name: 'tone', label: { en: 'Tone' } }] });
    const before = structuredClone(raw);
    const given = options();
    const optionsBefore = structuredClone({ ...given, isTaken: undefined });
    sanitize(raw, given);
    assert.deepEqual(raw, before);
    assert.deepEqual({ ...given, isTaken: undefined }, optionsBefore);
  });
});

describe('the recorded answers in fixtures/app-generator', () => {
  const files = fs
    .readdirSync(FIXTURES)
    .filter(file => file.endsWith('.txt'))
    .sort();

  it('has hand-written answers of every kind', () => {
    for (const prefix of ['ok-', 'not-json-', 'truncated-', 'incomplete-']) {
      assert.ok(
        files.some(file => file.startsWith(prefix)),
        `no fixture starts with ${prefix}`
      );
    }
  });

  for (const file of files) {
    const text = fs.readFileSync(new URL(file, FIXTURES), 'utf8');
    const expected = ['ok', 'not-json', 'truncated', 'incomplete'].find(kind =>
      file.startsWith(`${kind}-`)
    );
    const finishReason = expected === 'truncated' ? 'length' : 'stop';
    const run = () =>
      sanitizeGeneratedApp(parseGeneratedAnswer(text, finishReason), options({ language: 'en' }));

    it(`${file}: ${expected || 'has no known prefix'}`, () => {
      assert.ok(expected, 'name the file ok-, not-json-, truncated- or incomplete-');
      if (expected !== 'ok') {
        assert.equal(refusal(run), expected);
        return;
      }
      const { app, suggestions, warnings } = run();
      assertValidApp(app);
      assert.equal(app.enabled, false);
      assert.equal(app.type, 'chat');
      assert.equal('integrations' in app, false);
      assert.equal('websearch' in app, false);
      assert.equal('preferredModel' in app, false);
      assert.deepEqual(unusedVariables(app), []);
      for (const value of [app.name, app.description, app.system]) {
        assert.deepEqual(Object.keys(value), ['en']);
      }
      assert.equal(typeof suggestions.websearch, 'boolean');
      assert.ok(Array.isArray(suggestions.integrations));
      for (const warning of warnings) {
        assert.ok(Object.hasOwn(APP_GENERATOR_WARNINGS, warning.code), warning.code);
      }
    });
  }

  it('reads the old library format: one language kept, the model and the bindings left out', () => {
    const text = fs.readFileSync(new URL('ok-old-library-format.txt', FIXTURES), 'utf8');
    const { app, suggestions, warnings } = sanitizeGeneratedApp(
      parseGeneratedAnswer(text, 'stop'),
      options({ language: 'de' })
    );
    assert.equal(app.id, 'e-mail-verfasser');
    assert.deepEqual(app.name, { de: 'E-Mail-Verfasser' });
    assert.deepEqual(app.variables[0].label, { de: 'E-Mail-Typ' });
    // The default names the option "Professionell" and is stored as that option's label.
    assert.deepEqual(app.variables[0].defaultValue, { de: 'Professionell' });
    assert.equal(app.category, 'business');
    assert.equal(app.allowEmptyContent, true);
    assert.equal(app.sendChatHistory, true);
    assert.equal(app.preferredOutputFormat, 'markdown');
    assert.deepEqual(suggestions, {
      websearch: true,
      integrations: [{ id: 'jira', label: 'Jira', actions: ['searchIssues'] }]
    });
    assert.deepEqual(
      warnings.map(warning => warning.field),
      [
        'preferredModel',
        'preferredOutputFormat',
        'preferredStyle',
        'sendChatHistory',
        'allowEmptyContent'
      ]
    );
  });
});
