// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The app generator brief: the shipped example is a valid app, the installed
 * integrations the app may bind are listed in the prompt and limit the answer
 * schema, and the answer's `integrations` becomes the app's bindings.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildAppGeneratorBrief,
  describeInstalledIntegrations,
  integrationsFromAnswer,
  integrationsBlock,
  schemaWithIntegrations
} from '../services/appGenerator.js';
import { appConfigSchema } from '../validators/appConfigSchema.js';

const shipped = JSON.parse(
  fs.readFileSync(new URL('../defaults/prompts/app-generator.json', import.meta.url), 'utf8')
);

const resolved = [
  {
    instance: { id: 'ifinder' },
    label: 'iFinder',
    definition: {
      type: 'search',
      description: { en: 'Enterprise search' },
      actions: [{ name: 'search' }, { name: 'getContent' }]
    }
  },
  {
    instance: { id: 'jira' },
    definition: { name: { en: 'Jira' }, actions: [{ name: 'searchTickets' }] }
  }
];

describe('the shipped prompt', () => {
  for (const lang of ['en', 'de']) {
    it(`has an example app (${lang}) that the app schema accepts`, () => {
      const example = shipped.prompt[lang].match(/```json\n([\s\S]*?)\n```/)[1];
      const parsed = appConfigSchema.safeParse(JSON.parse(example));
      assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
    });
  }

  it('has no tools field in its answer schema, and the fields the wizard applies', () => {
    assert.equal('tools' in shipped.outputSchema.properties, false);
    assert.equal(shipped.outputSchema.required.includes('tools'), false);
    for (const name of ['color', 'icon', 'prompt', 'variables', 'websearch']) {
      assert.ok(shipped.outputSchema.properties[name], name);
    }
  });
});

describe('the brief', () => {
  const integrations = describeInstalledIntegrations(resolved, 'en');

  it('describes the enabled installations', () => {
    assert.deepEqual(
      integrations.map(entry => [entry.id, entry.label, entry.type]),
      [
        ['ifinder', 'iFinder', 'search'],
        ['jira', 'Jira', null]
      ]
    );
    assert.deepEqual(integrations[0].actions, ['search', 'getContent']);
  });

  it('lists them in the prompt and limits the answer to their ids', () => {
    const brief = buildAppGeneratorBrief(shipped, 'de', 'en', integrations);
    assert.match(brief.prompt, /INTEGRATIONS:/);
    assert.match(brief.prompt, /- ifinder \(iFinder, search\)/);
    assert.deepEqual(brief.outputSchema.properties.integrations.items.properties.id.enum, [
      'ifinder',
      'jira'
    ]);
    // The stored schema is not changed.
    assert.equal('integrations' in shipped.outputSchema.properties, false);
  });

  it('adds nothing when no integration is installed', () => {
    assert.equal(integrationsBlock([]), '');
    const brief = buildAppGeneratorBrief(shipped, 'en', 'en', []);
    assert.equal('integrations' in brief.outputSchema.properties, false);
    assert.equal(brief.prompt, shipped.prompt.en);
    assert.equal(schemaWithIntegrations(undefined, []).type, 'object');
  });
});

describe('integrationsFromAnswer', () => {
  it('keeps installed ids once, with their action lists', () => {
    assert.deepEqual(
      integrationsFromAnswer(
        [
          { id: 'ifinder', actions: ['search'] },
          { id: 'jira' },
          { id: 'ifinder' },
          { id: 'invented' },
          'jira'
        ],
        ['ifinder', 'jira']
      ),
      { ifinder: { actions: ['search'] }, jira: {} }
    );
  });

  it('answers nothing for an empty or malformed pick', () => {
    assert.equal(integrationsFromAnswer(undefined, ['x']), undefined);
    assert.equal(integrationsFromAnswer([{ id: 'nope' }], ['x']), undefined);
    assert.equal(integrationsFromAnswer('x', ['x']), undefined);
  });
});
