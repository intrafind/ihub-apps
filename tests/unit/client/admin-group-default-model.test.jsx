// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The default-model token (`@default`) in the admin UI: the group editor's
 * model picker shows it readably and lets an admin add and remove it, the
 * usage limits show the default model's row in its place, and the access
 * explanation words a "default" route and the restrict plan's
 * `defaultModelGroups`.
 */

import '@testing-library/jest-dom';
import { fireEvent, render, screen, act } from '@testing-library/react';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';

jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  __esModule: true,
  fetchInstalledIntegrations: async () => ({ data: [] })
}));

jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  getAdminApiErrorMessage: err => err?.message || 'error',
  fetchAdminModels: async () => [],
  makeAdminApiCall: async () => ({ data: {} }),
  previewAccessRestriction: async () => ({}),
  restrictItemAccess: async () => ({})
}));

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => '',
  buildPath: path => path,
  buildAssetUrl: path => path
}));

let mockLanguage = 'en';
jest.mock('react-i18next', () => {
  const { enT, deT } = require('./helpers/i18nMock');
  const translations = {
    en: { t: enT, i18n: { language: 'en' } },
    de: { t: deT, i18n: { language: 'de' } }
  };
  return { useTranslation: () => translations[mockLanguage] };
});

const GroupFormEditorModule = require('../../../client/src/features/admin/components/GroupFormEditor');
const GroupFormEditor = GroupFormEditorModule.default;
const { modelPermissionChoices } = GroupFormEditorModule;
const {
  limitModelRows
} = require('../../../client/src/features/admin/components/UsageLimitsEditor');
const {
  ROUTE_KEYS,
  defaultModelGroupNames,
  formatSentence,
  routeSentence
} = require('../../../client/src/features/admin/components/access/accessExplanation');
const { DEFAULT_MODEL_TOKEN } = require('../../../shared/modelPermissions.js');

const lookup = (messages, key) => key.split('.').reduce((node, part) => node?.[part], messages);
const LABEL_EN = en.admin.groups.form.defaultModelToken;
const LABEL_DE = de.admin.groups.form.defaultModelToken;

const RESOURCES = {
  apps: [],
  models: [
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'claude', name: 'Claude' }
  ],
  prompts: [],
  workflows: [],
  skills: []
};

function groupWith(models) {
  return {
    id: 'anonymous',
    name: 'Anonymous',
    description: '',
    permissions: { apps: ['chat'], models },
    mappings: [],
    inherits: []
  };
}

async function renderEditor(models, onChange = jest.fn()) {
  await act(async () => {
    render(<GroupFormEditor value={groupWith(models)} onChange={onChange} resources={RESOURCES} />);
  });
  return onChange;
}

/** The model picker: the selector labelled "Models". */
const modelSearch = () => screen.getByLabelText(en.admin.nav.models, { selector: 'input' });

afterEach(() => {
  mockLanguage = 'en';
});

describe('group editor model picker', () => {
  test('the English and German labels exist', () => {
    expect(typeof LABEL_EN).toBe('string');
    expect(typeof LABEL_DE).toBe('string');
    expect(LABEL_DE).not.toBe(LABEL_EN);
  });

  test('shows the token as a readable chip next to named models', async () => {
    await renderEditor([DEFAULT_MODEL_TOKEN, 'gpt-4o']);
    expect(screen.getByText(LABEL_EN)).toBeInTheDocument();
    expect(screen.getByText('GPT-4o')).toBeInTheDocument();
    expect(screen.queryByText(DEFAULT_MODEL_TOKEN)).not.toBeInTheDocument();
  });

  test('shows the German label in German', async () => {
    mockLanguage = 'de';
    await renderEditor([DEFAULT_MODEL_TOKEN]);
    expect(screen.getByText(LABEL_DE)).toBeInTheDocument();
  });

  test('removes the token', async () => {
    const onChange = await renderEditor([DEFAULT_MODEL_TOKEN, 'gpt-4o']);
    const chip = screen.getByText(LABEL_EN).closest('span');
    fireEvent.click(chip.querySelector('button'));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        permissions: expect.objectContaining({ models: ['gpt-4o'] })
      })
    );
  });

  test('adds the token from the picker', async () => {
    const onChange = await renderEditor(['claude']);
    const search = modelSearch();
    fireEvent.focus(search);
    fireEvent.change(search, { target: { value: 'default' } });
    fireEvent.click(screen.getByRole('button', { name: LABEL_EN }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        permissions: expect.objectContaining({ models: ['claude', DEFAULT_MODEL_TOKEN] })
      })
    );
  });

  test('puts the token first among the choices, once', () => {
    const t = (key, fallback) => fallback;
    const choices = modelPermissionChoices(
      [{ id: DEFAULT_MODEL_TOKEN, name: 'x' }, ...RESOURCES.models],
      t
    );
    expect(choices.map(choice => choice.id)).toEqual([DEFAULT_MODEL_TOKEN, 'gpt-4o', 'claude']);
    expect(choices[0].name).toBe('Default model (whichever is set as default)');
  });
});

describe('usage limit rows', () => {
  test('show the default model in place of the token', () => {
    const models = [{ id: 'gpt-4o' }, { id: 'claude', default: true }];
    const { rows } = limitModelRows([DEFAULT_MODEL_TOKEN, 'gpt-4o'], models, {});
    expect(rows.map(row => row.id).sort()).toEqual(['claude', 'gpt-4o']);
  });

  test('drop the token when no model is the default', () => {
    const { rows } = limitModelRows([DEFAULT_MODEL_TOKEN], [{ id: 'gpt-4o' }], {});
    expect(rows).toEqual([]);
  });
});

describe('access explanation of a default route', () => {
  const nameOf = id => ({ anonymous: 'Anonymous', hr: 'HR', authenticated: 'Everyone' })[id] || id;
  const t = (key, values = {}) =>
    String(lookup(en, key) ?? key).replace(
      /{{(\w+)}}/g,
      (_, name) => values[name] ?? `{{${name}}}`
    );

  test('every route key is a text in English and German', () => {
    for (const key of Object.values(ROUTE_KEYS)) {
      expect(typeof lookup(en, key)).toBe('string');
      expect(typeof lookup(de, key)).toBe('string');
    }
    expect(typeof en.admin.access.restrict.stillDefaultModel).toBe('string');
    expect(typeof de.admin.access.restrict.stillDefaultModel).toBe('string');
  });

  test('says the group gets the model as the default model', () => {
    const own = routeSentence({
      groupName: 'Anonymous',
      route: { groupId: 'anonymous', kind: 'default', path: ['anonymous'] },
      type: 'models',
      nameOf
    });
    expect(own.key).toBe(ROUTE_KEYS.ownDefault);
    expect(formatSentence(own, t)).toContain('as the default model');

    const inherited = routeSentence({
      groupName: 'HR',
      route: { groupId: 'anonymous', kind: 'default', path: ['hr', 'authenticated', 'anonymous'] },
      type: 'models',
      nameOf
    });
    expect(inherited.key).toBe(ROUTE_KEYS.inheritedDefault);
    expect(formatSentence(inherited, t)).toContain('HR → Everyone → Anonymous');
  });

  test('keeps the wording of wildcard and named routes', () => {
    expect(
      routeSentence({
        groupName: 'HR',
        route: { groupId: 'hr', kind: 'explicit', path: ['hr'] },
        type: 'models',
        nameOf
      }).key
    ).toBe(ROUTE_KEYS.ownExplicit);
    expect(
      routeSentence({
        groupName: 'HR',
        route: { groupId: 'users', kind: 'wildcard', path: ['hr', 'users'] },
        type: 'models',
        nameOf
      }).key
    ).toBe(ROUTE_KEYS.inheritedWildcard);
  });

  test('names the groups that keep a restricted model as the default model', () => {
    expect(
      defaultModelGroupNames({
        defaultModelGroups: ['anonymous'],
        groupsAfter: [{ id: 'anonymous', name: 'Anonymous' }]
      })
    ).toEqual(['Anonymous']);
    expect(defaultModelGroupNames({})).toEqual([]);
    expect(defaultModelGroupNames(null)).toEqual([]);
  });
});
