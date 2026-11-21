// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The templates of the app builder (`server/appTemplates/`,
 * `GET /api/admin/app-templates`).
 *
 * A template is a starting text, not an app: it holds content only, in English
 * and German, binds nothing and changes no setting. The checks here are the
 * reason the shipped default apps are not served as templates: one binds a
 * knowledge project, one has English-only instructions, four switch upload on.
 *
 * Run: node --test server/tests/app-templates.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  APP_TEMPLATES_DIR,
  APP_TEMPLATE_IDS,
  APP_TEMPLATE_KEYS,
  appTemplateProblems,
  loadAppTemplates,
  localizedTextsOf
} from '../services/appTemplates.js';
import { appConfigSchema } from '../validators/appConfigSchema.js';
import { newAppDefaults } from '../../shared/appDefaults.js';
import { isValidAppId } from '../../shared/appId.js';
import { unusedVariables } from '../../shared/appPlaceholders.js';

const read = id => JSON.parse(fs.readFileSync(path.join(APP_TEMPLATES_DIR, `${id}.json`), 'utf8'));

/** Keys that would make a template more than a starting text. */
const NEVER_IN_A_TEMPLATE = [
  'projects',
  'integrations',
  'websearch',
  'tools',
  'apps',
  'workflows',
  'skills',
  'iassistant',
  'requiredIntegrations',
  'preferredModel',
  'allowedModels',
  'upload',
  'settings',
  'enabled'
];

// The same rules the translation test applies to the product's German texts.
const INFORMAL = /\b(du|dich|dir|dein|deine|deinem|deinen|deiner|deines|euch|euer|eure)\b/i;
const INFORMAL_IMPERATIVE =
  /(?:^|[.!?:]\s+|\n-?\s*)(Antworte|Baue|Behalte|Beachte|Bestätige|Bewerte|Entferne|Erkläre|Erstelle|Fasse|Frage|Füge|Gehe|Gib|Halte|Hilf|Klicke|Lass|Mache|Nenne|Nutze|Öffne|Richte|Schreibe|Sei|Stelle|Trage|Übersetze|Verwende|Wähle|Wiederhole)\s(?!Sie\b)/;
const NUTZER = /(?<!Be)nutzer/i;

describe('the list of templates', () => {
  it('names six templates, in the order of the gallery', () => {
    assert.deepEqual(
      [...APP_TEMPLATE_IDS],
      [
        'summarizer',
        'translator',
        'email-composer',
        'plain-language',
        'meeting-minutes',
        'idea-coach'
      ]
    );
  });

  it('lives outside server/defaults, which the setup copies into contents/', () => {
    const relative = path.relative(path.resolve(APP_TEMPLATES_DIR, '..'), APP_TEMPLATES_DIR);
    assert.equal(relative, 'appTemplates');
    assert.equal(path.basename(path.resolve(APP_TEMPLATES_DIR, '..')), 'server');
    assert.ok(!APP_TEMPLATES_DIR.includes(`${path.sep}defaults${path.sep}`));
  });

  it('has one file per ID and no other file', () => {
    assert.deepEqual(
      fs.readdirSync(APP_TEMPLATES_DIR).sort(),
      APP_TEMPLATE_IDS.map(id => `${id}.json`).sort()
    );
  });

  it('allows only content keys', () => {
    assert.deepEqual(
      [...APP_TEMPLATE_KEYS],
      [
        'id',
        'name',
        'description',
        'icon',
        'color',
        'category',
        'system',
        'prompt',
        'messagePlaceholder',
        'variables',
        'starterPrompts',
        'allowEmptyContent'
      ]
    );
    for (const key of NEVER_IN_A_TEMPLATE) assert.ok(!APP_TEMPLATE_KEYS.includes(key), key);
  });
});

for (const id of APP_TEMPLATE_IDS) {
  describe(`template ${id}`, () => {
    const template = read(id);

    it('exists, has its ID and holds no key outside the list', () => {
      assert.equal(template.id, id);
      assert.ok(isValidAppId(id));
      for (const key of Object.keys(template)) assert.ok(APP_TEMPLATE_KEYS.includes(key), key);
      for (const key of NEVER_IN_A_TEMPLATE) assert.equal(Object.hasOwn(template, key), false, key);
    });

    it('passes the app schema when merged with the defaults of a new app', () => {
      for (const language of ['en', 'de']) {
        const parsed = appConfigSchema.safeParse({ ...newAppDefaults(language), ...template });
        assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
      }
    });

    it('has name, short description and instructions, and every text in en and de', () => {
      for (const key of ['name', 'description', 'system']) {
        assert.equal(typeof template[key], 'object', key);
      }
      const texts = localizedTextsOf(template);
      assert.ok(texts.length >= 3);
      for (const [at, value] of texts) {
        assert.deepEqual(Object.keys(value).sort(), ['de', 'en'], at);
        for (const language of ['en', 'de']) {
          assert.equal(typeof value[language], 'string', `${at}.${language}`);
          assert.ok(value[language].trim().length > 0, `${at}.${language}`);
        }
      }
    });

    it('uses every input field in a text, in both languages', () => {
      assert.deepEqual(unusedVariables(template), []);
      for (const language of ['en', 'de']) {
        const oneLanguage = {
          system: { [language]: template.system[language] },
          prompt: template.prompt ? { [language]: template.prompt[language] } : undefined,
          variables: template.variables
        };
        assert.deepEqual(unusedVariables(oneLanguage), [], language);
      }
    });

    it('addresses the reader with "Sie" and says „Benutzer" in German', () => {
      const german = localizedTextsOf(template).map(([at, value]) => [at, value.de]);
      for (const [at, text] of german) {
        const plain = text.replace(/\{\{[^}]*\}\}/g, '');
        assert.doesNotMatch(plain, INFORMAL, at);
        assert.doesNotMatch(plain, INFORMAL_IMPERATIVE, at);
        assert.doesNotMatch(plain, NUTZER, at);
      }
      // The instructions address the AI formally, as the product addresses its readers.
      assert.match(template.system.de, /\bSie\b/);
    });

    it('offers a default that is one of the options of a dropdown', () => {
      for (const variable of template.variables || []) {
        const values = (variable.predefinedValues || []).map(option => option.value);
        if (values.length === 0 || !variable.defaultValue) continue;
        for (const language of ['en', 'de']) {
          assert.ok(
            values.includes(variable.defaultValue[language]),
            `${variable.name}.${language}`
          );
        }
      }
    });

    it('has no problem for the loader', () => {
      assert.deepEqual(appTemplateProblems(id, template), []);
    });
  });
}

describe('what the plan says each template is', () => {
  const fields = id => (read(id).variables || []).map(variable => variable.name);

  it('has the input fields of the table', () => {
    assert.deepEqual(fields('summarizer'), ['length']);
    assert.deepEqual(fields('translator'), ['language']);
    assert.deepEqual(fields('email-composer'), ['tone']);
    assert.deepEqual(fields('plain-language'), ['reading_level']);
    assert.deepEqual(fields('meeting-minutes'), []);
    assert.deepEqual(fields('idea-coach'), []);
  });

  it('makes every input field a dropdown', () => {
    for (const id of APP_TEMPLATE_IDS) {
      for (const variable of read(id).variables || []) {
        assert.ok(variable.predefinedValues.length >= 3, `${id}.${variable.name}`);
      }
    }
  });

  it('gives the idea coach three conversation starters', () => {
    assert.equal(read('idea-coach').starterPrompts.length, 3);
  });
});

describe('loadAppTemplates', () => {
  it('returns the six templates as list items, in order', async () => {
    const items = await loadAppTemplates();
    assert.deepEqual(
      items.map(item => item.id),
      [...APP_TEMPLATE_IDS]
    );
    for (const item of items) {
      const template = read(item.id);
      assert.deepEqual(Object.keys(item), [
        'id',
        'name',
        'description',
        'icon',
        'color',
        'category',
        'hasInputFields',
        'app'
      ]);
      assert.deepEqual(item.name, template.name);
      assert.deepEqual(item.description, template.description);
      assert.equal(item.icon, template.icon);
      assert.equal(item.color, template.color);
      assert.equal(item.category, template.category);
      assert.equal(item.hasInputFields, (template.variables || []).length > 0);
      // `app` is the content of the file, without its ID.
      const { id, ...content } = template;
      assert.equal(typeof id, 'string');
      assert.deepEqual(item.app, content);
      assert.equal('id' in item.app, false);
    }
    assert.deepEqual(
      items.filter(item => item.hasInputFields).map(item => item.id),
      ['summarizer', 'translator', 'email-composer', 'plain-language']
    );
  });

  it('hands out a copy: changing the answer does not change the next one', async () => {
    const first = await loadAppTemplates();
    first[0].name.en = 'changed';
    first[0].app.system.en = 'changed';
    first.pop();
    const second = await loadAppTemplates();
    assert.equal(second.length, 6);
    assert.notEqual(second[0].name.en, 'changed');
    assert.notEqual(second[0].app.system.en, 'changed');
  });

  it('skips a file that is missing, unreadable or fails a check, and serves the rest', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-app-templates-'));
    try {
      const write = (id, content) =>
        fs.writeFileSync(
          path.join(dir, `${id}.json`),
          typeof content === 'string' ? content : JSON.stringify(content)
        );
      write('summarizer', read('summarizer'));
      // translator: missing.
      write('email-composer', '{ not json');
      write('plain-language', { ...read('plain-language'), upload: { enabled: true } });
      write('meeting-minutes', { ...read('meeting-minutes'), id: 'other-id' });
      write('idea-coach', { ...read('idea-coach'), system: { en: 'English only.' } });

      const items = await loadAppTemplates({ dir });
      assert.deepEqual(
        items.map(item => item.id),
        ['summarizer']
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('appTemplateProblems', () => {
  const valid = () => read('summarizer');
  const problems = change => {
    const template = valid();
    change(template);
    return appTemplateProblems('summarizer', template);
  };

  it('finds nothing in a shipped template', () => {
    assert.deepEqual(appTemplateProblems('summarizer', valid()), []);
  });

  it('refuses what is not an object', () => {
    for (const value of [null, 'text', [], 7]) {
      assert.deepEqual(appTemplateProblems('summarizer', value), ['is not a JSON object']);
    }
  });

  it('refuses every key outside the list', () => {
    for (const key of NEVER_IN_A_TEMPLATE) {
      const found = problems(template => {
        template[key] = key === 'enabled' ? true : ['x'];
      });
      assert.ok(
        found.some(problem => problem.includes('may not hold') && problem.includes(key)),
        `${key}: ${found.join(' | ')}`
      );
    }
  });

  it('refuses a text that lacks a language', () => {
    assert.ok(problems(t => delete t.system.de).includes('has no de text for system'));
    assert.ok(problems(t => (t.name.en = ' ')).includes('has no en text for name'));
    assert.ok(
      problems(t => delete t.variables[0].label.de).includes(
        'has no de text for variables[0].label'
      )
    );
    assert.ok(
      problems(t => delete t.variables[0].predefinedValues[1].label.en).includes(
        'has no en text for variables[0].predefinedValues[1].label'
      )
    );
    assert.ok(problems(t => delete t.description).includes('has no description'));
  });

  it('refuses an input field that no text uses', () => {
    const found = problems(template => {
      template.variables.push({
        name: 'unused',
        label: { en: 'Unused', de: 'Ungenutzt' },
        type: 'string'
      });
    });
    assert.ok(found.includes('has input fields that no text uses: unused'), found.join(' | '));
  });

  it('refuses what the app schema refuses', () => {
    const found = problems(template => {
      template.color = 'orange';
    });
    assert.ok(
      found.some(problem => problem.startsWith('does not pass the app schema (color:')),
      found.join(' | ')
    );
  });

  it('refuses a file listed under another ID', () => {
    assert.deepEqual(appTemplateProblems('translator', valid()), [
      'has the id "summarizer" instead of "translator"'
    ]);
  });
});
