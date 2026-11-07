// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  describeModelProvider,
  getSetupSteps,
  isLlmProviderEntry
} from '../../../client/src/features/admin/utils/modelsArea';

const model = (extra = {}) => ({ id: 'm', provider: 'openai', enabled: false, ...extra });

describe('getSetupSteps', () => {
  const states = result => result.steps.map(step => [step.id, step.done]);

  test('a fresh install has nothing done', () => {
    expect(
      states(getSetupSteps({ keyStatuses: { openai: { state: 'missing' } }, models: [] }))
    ).toEqual([
      ['connect', false],
      ['enable', false],
      ['default', false]
    ]);
  });

  test('a stored or environment key connects; an unreadable one does not', () => {
    expect(getSetupSteps({ keyStatuses: { p: { state: 'ok' } } }).steps[0].done).toBe(true);
    expect(getSetupSteps({ keyStatuses: { p: { state: 'undecryptable' } } }).steps[0].done).toBe(
      false
    );
  });

  test('the shipped keyless local provider does not connect by itself, an enabled model does', () => {
    const keyless = { local: { state: 'keyless' } };
    expect(getSetupSteps({ keyStatuses: keyless, models: [model()] }).steps[0].done).toBe(false);
    expect(
      getSetupSteps({ keyStatuses: keyless, models: [model({ enabled: true })] }).steps[0].done
    ).toBe(true);
  });

  test('enabling counts enabled models; a default must itself be enabled', () => {
    const result = getSetupSteps({
      keyStatuses: { p: { state: 'ok' } },
      models: [model({ enabled: true }), model({ default: true })]
    });
    expect(result.steps[1]).toMatchObject({ done: true, count: 1 });
    expect(result.steps[2].done).toBe(false);
    expect(result.complete).toBe(false);
  });

  test('is complete with a connected provider, an enabled model and an enabled default', () => {
    expect(
      getSetupSteps({
        keyStatuses: { p: { state: 'ok' } },
        models: [model({ enabled: true, default: true })]
      }).complete
    ).toBe(true);
  });
});

describe('describeModelProvider', () => {
  const providers = [
    { id: 'openai', name: 'OpenAI' },
    { id: 'llmhub', name: { en: 'LLM Hub', de: 'LLM-Hub' } }
  ];

  test('an unlinked model uses the provider entry named after its API type', () => {
    expect(describeModelProvider(model(), providers, 'en')).toMatchObject({
      id: 'openai',
      name: 'OpenAI'
    });
  });

  test('a linked model uses its providerId, with the entry name in the UI language', () => {
    expect(describeModelProvider(model({ providerId: 'llmhub' }), providers, 'de').name).toBe(
      'LLM-Hub'
    );
  });

  test('a model whose provider has no entry has no name', () => {
    expect(
      describeModelProvider(model({ provider: 'iassistant-conversation' }), providers, 'en')
    ).toMatchObject({ id: 'iassistant-conversation', entry: undefined, name: null });
  });
});

test('entries without a category are model providers; other categories are not', () => {
  expect(isLlmProviderEntry({ id: 'openai' })).toBe(true);
  expect(isLlmProviderEntry({ category: 'llm' })).toBe(true);
  expect(isLlmProviderEntry({ category: 'custom' })).toBe(false);
});
