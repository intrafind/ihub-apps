// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The helpers behind the model lifecycle in the admin: the delete-dialog text
 * built from `…/_dependants` (AI-B12), the model choices of the app editor
 * (AI-B9), the `Default-Model-Assigned` header (AI-B13) and the model test.
 */

const mockFetchModels = jest.fn();
jest.mock('../../../client/src/api/client', () => ({ __esModule: true, apiClient: jest.fn() }));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildPath: p => p,
  buildApiUrl: p => `/api${p}`
}));
jest.mock('../../../client/src/api', () => ({
  fetchModels: (...args) => mockFetchModels(...args),
  fetchUIConfig: jest.fn()
}));
jest.mock('../../../client/src/utils/schemaService', () => ({ fetchJsonSchema: jest.fn() }));

const {
  appDeleteConsequences,
  deleteWithHistoryMessage,
  modelDeleteConsequences
} = require('../../../client/src/features/admin/utils/deleteDependants');
const {
  hasNoUsableModel,
  modelChoices
} = require('../../../client/src/features/admin/components/app-form/modelChoices');
const { assignedDefaultModelId } = require('../../../client/src/api/adminApi');
const { runModelTest } = require('../../../client/src/features/admin/utils/modelTestMessages');

/** `t` with the fallback (string or `defaultValue`) and `{{name}}` filled in. */
const t = (key, fallbackOrOptions, maybeOptions) => {
  const options = typeof fallbackOrOptions === 'object' ? fallbackOrOptions : maybeOptions || {};
  const text = typeof fallbackOrOptions === 'string' ? fallbackOrOptions : options.defaultValue;
  if (typeof text !== 'string') return key;
  return text.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options[name] ?? ''));
};

describe('modelDeleteConsequences', () => {
  test('nothing names the model: no bullets', () => {
    expect(
      modelDeleteConsequences({ apps: [], workflows: [], groups: [], isDefault: false }, { t })
    ).toEqual([]);
  });

  test('names the referring items in the UI language, at most five', () => {
    const apps = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => ({
      id,
      name: { en: `App ${id}`, de: `Anwendung ${id}` },
      references: ['allowedModels']
    }));
    const [line] = modelDeleteConsequences(
      { apps, workflows: [], groups: [], isDefault: false },
      { t, language: 'de' }
    );
    expect(line).toBe(
      'Apps that name it (they answer with another model): Anwendung a, Anwendung b, Anwendung c, Anwendung d, Anwendung e, and 2 more'
    );
  });

  test('names the agents that use the model', () => {
    const lines = modelDeleteConsequences(
      {
        apps: [],
        workflows: [],
        agents: [{ id: 'analyst', name: { en: 'Analyst' }, references: ['preferredModel'] }],
        groups: [],
        isDefault: false
      },
      { t, language: 'en' }
    );
    expect(lines).toEqual(['Agents that name it: Analyst']);
  });

  test('says which model becomes the default, or that none can', () => {
    const base = { apps: [], workflows: [], groups: [], isDefault: true };
    expect(
      modelDeleteConsequences(
        { ...base, nextDefaultModelId: 'large' },
        { t, modelName: id => `Model ${id}` }
      )
    ).toEqual(['It is the default model. "Model large" becomes the default.']);
    expect(modelDeleteConsequences(base, { t })[0]).toMatch(/no other enabled chat model/);
  });

  test('a failed check says so', () => {
    expect(modelDeleteConsequences(null, { t })[0]).toMatch(/^Could not check what uses it/);
  });
});

describe('appDeleteConsequences', () => {
  test('lists prompts, tool callers, children, workflows and groups apart', () => {
    expect(
      appDeleteConsequences(
        {
          prompts: [{ id: 'p', name: { en: 'Translate a mail' } }],
          apps: [
            { id: 'assistant', name: { en: 'Assistant' }, references: ['tool'] },
            { id: 'child', name: { en: 'Child' }, references: ['parent'] }
          ],
          workflows: [{ id: 'flow', name: 'Flow' }],
          groups: [{ id: 'legal', name: 'Legal' }]
        },
        { t, language: 'en' }
      )
    ).toEqual([
      'Prompts that open in it: Translate a mail',
      'Apps that call it as a tool: Assistant',
      'Apps that inherit from it: Child',
      'Workflows that call it: Flow',
      'Groups that grant it by name: Legal'
    ]);
  });

  test('an app nothing names gets no bullets; a failed check says so', () => {
    expect(
      appDeleteConsequences({ prompts: [], apps: [], workflows: [], groups: [] }, { t })
    ).toEqual([]);
    expect(appDeleteConsequences(null, { t })).toHaveLength(1);
  });
});

test('deleteWithHistoryMessage points to the page that restores the item', () => {
  expect(deleteWithHistoryMessage({ type: 'app', path: '/admin/apps/x', t })).toBe(
    'The app is removed for all users. A copy stays in the change history: open /admin/apps/x again to restore it.'
  );
});

describe('modelChoices', () => {
  test('marks disabled models and the default, keeps the rest as they are', () => {
    expect(
      modelChoices(
        [
          { id: 'on', name: { en: 'On' }, enabled: true },
          { id: 'off', name: 'Off', enabled: false },
          { id: 'main', name: { en: 'Main' }, enabled: true, default: true },
          { id: 'bare' }
        ],
        t,
        'en'
      )
    ).toEqual([
      { id: 'on', name: 'On', enabled: true },
      { id: 'off', name: 'Off (disabled)', enabled: false },
      { id: 'main', name: 'Main (default)', enabled: true },
      { id: 'bare', name: 'bare', enabled: true }
    ]);
  });

  test('hasNoUsableModel: a known list without an enabled model', () => {
    expect(hasNoUsableModel(null)).toBe(false);
    expect(hasNoUsableModel([])).toBe(true);
    expect(hasNoUsableModel([{ id: 'a', enabled: false }])).toBe(true);
    // The public list carries no `enabled`: every model in it is usable.
    expect(hasNoUsableModel([{ id: 'a' }])).toBe(false);
  });
});

describe('assignedDefaultModelId', () => {
  test('reads and decodes the header from a plain or an AxiosHeaders object', () => {
    expect(assignedDefaultModelId({ headers: { 'default-model-assigned': 'gpt%204o' } })).toBe(
      'gpt 4o'
    );
    expect(
      assignedDefaultModelId({
        headers: { get: name => (name === 'default-model-assigned' ? 'large' : undefined) }
      })
    ).toBe('large');
    expect(assignedDefaultModelId({ headers: {} })).toBeNull();
    expect(assignedDefaultModelId(undefined)).toBeNull();
  });
});

describe('runModelTest', () => {
  test('an answer is a passed test', async () => {
    const request = jest.fn().mockResolvedValue({ data: { response: 'Hello' } });
    await expect(runModelTest('m 1', t, request)).resolves.toEqual({
      response: 'Hello',
      success: true
    });
    expect(request).toHaveBeenCalledWith('/admin/models/m%201/_test', { method: 'POST' });
  });

  test('an HTTP error is a failed test with its translated headline and the server details', async () => {
    const error = Object.assign(new Error('bad'), {
      response: {
        status: 502,
        data: {
          detail: 'Upstream said no',
          details: { messageKey: 'authenticationFailed', remediation: 'Check the key' }
        }
      }
    });
    const result = await runModelTest('m', t, jest.fn().mockRejectedValue(error));
    // The details (remedy, status, host, code) go to ConnectionErrorDetails; `error` is the
    // fallback when a response carries none.
    expect(result).toEqual({
      success: false,
      message: 'Upstream said no',
      details: { messageKey: 'authenticationFailed', remediation: 'Check the key' },
      error: 'HTTP 502'
    });
  });
});

describe('fetchEditorModels (the app editor reads the admin model list)', () => {
  const adminApi = require('../../../client/src/api/adminApi');
  const {
    fetchEditorModels
  } = require('../../../client/src/features/admin/components/app-editor/adminAppRequests');

  afterEach(() => jest.restoreAllMocks());

  test('lists the chat models of the admin list, disabled ones included', async () => {
    jest.spyOn(adminApi, 'fetchAdminModels').mockResolvedValue([
      { id: 'off', enabled: false },
      { id: 'voice', modelType: 'tts', enabled: true },
      { id: 'chat', modelType: 'chat', enabled: true }
    ]);
    await expect(fetchEditorModels()).resolves.toEqual([
      { id: 'off', enabled: false },
      { id: 'chat', modelType: 'chat', enabled: true }
    ]);
    expect(mockFetchModels).not.toHaveBeenCalled();
  });

  test('a content admin (403) gets the models they may use', async () => {
    jest
      .spyOn(adminApi, 'fetchAdminModels')
      .mockRejectedValue(Object.assign(new Error('forbidden'), { response: { status: 403 } }));
    mockFetchModels.mockResolvedValue([{ id: 'public' }]);
    await expect(fetchEditorModels()).resolves.toEqual([{ id: 'public' }]);
  });

  test('any other failure is passed on', async () => {
    jest
      .spyOn(adminApi, 'fetchAdminModels')
      .mockRejectedValue(Object.assign(new Error('down'), { response: { status: 500 } }));
    await expect(fetchEditorModels()).rejects.toThrow('down');
  });
});
