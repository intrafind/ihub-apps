// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The action detail of an installed integration (#2974):
 *
 *   - the test form is generated from the JSON schema and sends the
 *     arguments as the model would;
 *   - a write test needs the confirmation checkbox, and a refusal from the
 *     server is shown (the server enforces it, not the checkbox);
 *   - the result shows status, duration, the request as sent, the raw
 *     response and the Answer Sources;
 *   - the drawer shows what the model sees, where each value came from, the
 *     bindings and the usage, and saves an edited guidance for the current
 *     language;
 *   - every string comes from shared/i18n/en.json.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';

const mockApi = {
  fetchIntegrationAction: jest.fn(),
  saveIntegrationActionOverride: jest.fn(),
  testIntegrationAction: jest.fn(),
  setInstalledIntegrationApproval: jest.fn(),
  markInstalledIntegrationActionsReviewed: jest.fn()
};
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  fetchIntegrationAction: (...args) => mockApi.fetchIntegrationAction(...args),
  saveIntegrationActionOverride: (...args) => mockApi.saveIntegrationActionOverride(...args),
  testIntegrationAction: (...args) => mockApi.testIntegrationAction(...args),
  setInstalledIntegrationApproval: (...args) => mockApi.setInstalledIntegrationApproval(...args),
  markInstalledIntegrationActionsReviewed: (...args) =>
    mockApi.markInstalledIntegrationActionsReviewed(...args)
}));
jest.mock('../../../client/src/api/adminApi', () => ({
  getAdminApiErrorMessage: err => err?.response?.data?.error || err?.message || 'error'
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const mockI18n = i18next.createInstance();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockI18n.t.bind(mockI18n), i18n: mockI18n })
}));

const IntegrationActionDrawer =
  require('../../../client/src/features/admin/components/integrations/IntegrationActionDrawer').default;
const ActionTestPanel =
  require('../../../client/src/features/admin/components/integrations/ActionTestPanel').default;
const form = require('../../../client/src/features/admin/components/integrations/actionTestForm');

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en } },
    parseMissingKeyHandler: key => `MISSING:${key}`,
    saveMissing: false
  });
});

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
});

/** A detail as `GET …/actions/:action` answers with it. */
function detailOf(overrides = {}) {
  const base = {
    installation: {
      id: 'jira',
      label: 'Jira (EU)',
      definition: 'com.intrafind/jira',
      protocol: 'native',
      enabled: true,
      authMode: 'oauth-user'
    },
    action: {
      name: 'addComment',
      title: 'Add a comment',
      toolId: 'jira_addComment',
      httpMethod: null,
      description: 'Add a comment to an issue.',
      parameters: {
        type: 'object',
        properties: {
          issueKey: { type: 'string', description: 'The issue key' },
          comment: { type: 'string' },
          notify: { type: 'boolean' },
          priority: { type: 'string', enum: ['low', 'high'] },
          count: { type: 'integer' }
        },
        required: ['issueKey', 'comment']
      },
      guidance: 'Comment only when asked.',
      examples: ['Add a comment to DEMO-42 that staging passed.'],
      defaults: {
        description: 'Add a comment to an issue.',
        guidance: 'Comment only when asked.',
        examples: []
      },
      overridden: { description: false, guidance: false, examples: false },
      overrideTexts: { description: null, guidance: { de: 'Nur auf Wunsch.' }, examples: null },
      enabled: true,
      available: true,
      error: null,
      requirementsMet: true,
      review: null
    },
    effect: {
      sideEffect: 'write',
      sideEffectSource: 'definition',
      declaredSideEffect: 'write',
      methodSideEffect: null,
      dataFlow: 'external',
      dataFlowSource: 'definition',
      override: { sideEffect: null, dataFlow: null }
    },
    approval: {
      mode: 'writes',
      source: 'installation',
      actionMode: null,
      installationDefault: 'writes',
      newOrChanged: 'always'
    },
    instructions: { text: 'Jira holds the tickets.', source: 'definition', own: null },
    bindings: {
      apps: [{ id: 'support', name: 'Support Desk', via: 'installation', enabled: true }],
      workflows: [{ id: 'digest', name: 'Weekly digest', enabled: true }],
      scheduledTasks: [{ id: 'task-1', name: 'Morning summary', appId: 'support' }]
    },
    usage: {
      days: 7,
      calls: 61,
      errors: 0,
      approved: 12,
      rejected: 3,
      expired: 1,
      tests: 2,
      lastCallAt: null,
      lastErrorAt: null
    },
    test: {
      connections: [{ id: 'me', kind: 'personal' }],
      needsConfirmation: true,
      runnable: true
    }
  };
  return { ...base, ...overrides };
}

const RESULT = {
  status: 'ok',
  httpStatus: 201,
  durationMs: 412,
  error: null,
  connection: 'me',
  sideEffect: 'write',
  confirmed: true,
  request: {
    action: 'addComment',
    toolId: 'jira_addComment',
    args: { issueKey: 'DEMO-42', comment: 'Staging passed' },
    http: [
      {
        seq: 1,
        method: 'POST',
        url: 'https://jira.example/rest/api/2/issue/DEMO-42/comment',
        headers: { Authorization: '[redacted]' },
        body: '{"body":"Staging passed"}',
        status: 201,
        durationMs: 300
      }
    ]
  },
  response: { text: '{"id":"10001"}', truncated: false },
  sources: { items: [{ id: 's1', title: 'DEMO-42', url: 'https://jira.example/browse/DEMO-42' }] }
};

describe('actionTestForm', () => {
  it('generates fields from the schema, required first, and builds the arguments', () => {
    const fields = form.formFieldsFromSchema(detailOf().action.parameters);
    expect(fields.map(f => [f.name, f.kind, f.required])).toEqual([
      ['issueKey', 'string', true],
      ['comment', 'string', true],
      ['notify', 'boolean', false],
      ['priority', 'enum', false],
      ['count', 'integer', false]
    ]);
    expect(fields.find(f => f.name === 'comment').multiline).toBe(true);
    const values = { ...form.initialFormValues(fields), issueKey: 'DEMO-1', count: '3' };
    expect(form.argsFromFormValues(fields, values)).toEqual({
      args: { issueKey: 'DEMO-1', count: 3 },
      errors: { comment: 'required' }
    });
    expect(
      form.argsFromFormValues([{ name: 'x', kind: 'json', required: false }], { x: '{bad' }).errors
    ).toEqual({ x: 'json' });
  });

  it('edits one language of an override and keeps the others', () => {
    expect(form.withLanguageText({ de: 'Hallo' }, 'en', 'Hello')).toEqual({
      de: 'Hallo',
      en: 'Hello'
    });
    expect(form.withLanguageText('Plain', 'de', 'Hallo')).toEqual({ en: 'Plain', de: 'Hallo' });
    expect(form.withLanguageText({ de: 'Hallo' }, 'de', '')).toBeNull();
    expect(form.withLanguageExamples([{ de: 'Eins' }], 'en', 'One\n\nTwo')).toEqual([
      { de: 'Eins', en: 'One' },
      { en: 'Two' }
    ]);
    expect(form.baseLanguage('de-DE')).toBe('de');
  });
});

describe('ActionTestPanel', () => {
  it('requires the confirmation for a write and sends it with the generated arguments', async () => {
    mockApi.testIntegrationAction.mockResolvedValue(RESULT);
    render(<ActionTestPanel instanceId="jira" detail={detailOf()} userName="daniel" />);

    expect(screen.getByLabelText('My own connection (daniel)')).toBeChecked();
    const run = screen.getByRole('button', { name: 'Run test' });
    expect(run).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/issueKey/), { target: { value: 'DEMO-42' } });
    fireEvent.change(screen.getByLabelText(/^comment/), { target: { value: 'Staging passed' } });
    fireEvent.click(
      screen.getByLabelText(/I understand that this test can change data in Jira \(EU\)/)
    );
    expect(run).toBeEnabled();
    fireEvent.click(run);

    await screen.findByTestId('action-test-result');
    expect(mockApi.testIntegrationAction).toHaveBeenCalledWith('jira', 'addComment', {
      args: { issueKey: 'DEMO-42', comment: 'Staging passed' },
      connection: 'me',
      confirm: true
    });
    const result = screen.getByTestId('action-test-result');
    expect(within(result).getByText('Succeeded')).toBeInTheDocument();
    expect(within(result).getByText('HTTP 201')).toBeInTheDocument();
    expect(within(result).getByText('412 ms')).toBeInTheDocument();
    expect(within(result).getByText('Answer Sources: 1')).toBeInTheDocument();
    expect(screen.getByTestId('action-test-request').textContent).toContain('DEMO-42');
    expect(result.textContent).toContain('Authorization: [redacted]');
    expect(screen.getByTestId('action-test-response').textContent).toContain('10001');
    expect(within(screen.getByTestId('action-test-sources')).getByRole('link')).toHaveAttribute(
      'href',
      'https://jira.example/browse/DEMO-42'
    );
    expect(document.body.textContent).not.toMatch(/MISSING:/);
  });

  it('shows a missing required value without calling the server', () => {
    render(
      <ActionTestPanel
        instanceId="jira"
        detail={detailOf({
          test: {
            connections: [{ id: 'me', kind: 'none' }],
            needsConfirmation: false,
            runnable: true
          }
        })}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Run test' }));
    expect(screen.getAllByText('Required')).toHaveLength(2);
    expect(mockApi.testIntegrationAction).not.toHaveBeenCalled();
  });

  it('shows the server’s refusal', async () => {
    mockApi.testIntegrationAction.mockRejectedValue({
      response: { data: { error: 'This action is not a read: confirm the test to run it' } }
    });
    render(
      <ActionTestPanel
        instanceId="jira"
        detail={detailOf({
          action: { ...detailOf().action, parameters: { type: 'object', properties: {} } },
          test: {
            connections: [{ id: 'me', kind: 'none' }],
            needsConfirmation: false,
            runnable: true
          }
        })}
      />
    );
    expect(screen.getByText('This action takes no input.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run test' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('confirm the test to run it');
  });
});

describe('IntegrationActionDrawer', () => {
  function renderDrawer(props = {}) {
    return render(
      <MemoryRouter>
        <IntegrationActionDrawer
          isOpen
          onClose={() => {}}
          instanceId="jira"
          actionName="addComment"
          approval={{ default: 'writes' }}
          {...props}
        />
      </MemoryRouter>
    );
  }

  it('shows what the model sees, where each value came from, the bindings and the usage', async () => {
    mockApi.fetchIntegrationAction.mockResolvedValue(detailOf());
    const onTryInChat = jest.fn();
    renderDrawer({ onTryInChat });

    const drawer = await screen.findByRole('dialog', { name: 'Jira (EU) › Add a comment' });
    expect(mockApi.fetchIntegrationAction).toHaveBeenCalledWith('jira', 'addComment');
    for (const heading of [
      'What it does',
      'Side effect, data flow, approval',
      'How to use',
      'Test',
      'Usage in the last 7 days'
    ]) {
      expect(within(drawer).getByRole('heading', { name: heading })).toBeInTheDocument();
    }
    expect(within(drawer).getByText('Add a comment to an issue.')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('action-parameters')).getByText('issueKey')
    ).toBeInTheDocument();
    const sources = screen.getByTestId('action-effect-sources');
    expect(sources).toHaveTextContent('from integration definition');
    expect(sources).toHaveTextContent('from integration setting');
    expect(within(drawer).getByText('Comment only when asked.')).toBeInTheDocument();
    expect(within(drawer).getByText('Jira holds the tickets.')).toBeInTheDocument();
    const bindings = screen.getByTestId('action-bindings');
    expect(within(bindings).getByRole('link', { name: 'Support Desk' })).toHaveAttribute(
      'href',
      '/admin/apps/support'
    );
    expect(within(bindings).getByRole('link', { name: 'Weekly digest' })).toHaveAttribute(
      'href',
      '/admin/workflows/digest/edit'
    );
    expect(within(bindings).getByText('Morning summary')).toBeInTheDocument();
    const usage = screen.getByTestId('action-usage');
    expect(usage).toHaveTextContent('Calls61');
    expect(usage).toHaveTextContent('Rejected3');
    fireEvent.click(screen.getByTestId('action-try-in-chat'));
    expect(onTryInChat).toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/MISSING:/);
  });

  it('saves edited guidance for the current language and keeps the other languages', async () => {
    mockApi.fetchIntegrationAction.mockResolvedValue(detailOf());
    const updated = detailOf();
    updated.action = {
      ...updated.action,
      guidance: 'Quote the issue key.',
      overridden: { ...updated.action.overridden, guidance: true }
    };
    mockApi.saveIntegrationActionOverride.mockResolvedValue({ detail: updated });
    const onChanged = jest.fn();
    renderDrawer({ onChanged });

    const guidance = await screen.findByTestId('action-guidance');
    fireEvent.click(within(guidance).getByRole('button', { name: /Edit/ }));
    fireEvent.change(within(guidance).getByRole('textbox'), {
      target: { value: 'Quote the issue key.' }
    });
    fireEvent.click(within(guidance).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockApi.saveIntegrationActionOverride).toHaveBeenCalledWith('jira', 'addComment', {
        guidance: { de: 'Nur auf Wunsch.', en: 'Quote the issue key.' }
      })
    );
    await waitFor(() => expect(guidance).toHaveTextContent('Quote the issue key.'));
    expect(within(guidance).getByText('Edited')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it('saves a side effect override and the action’s approval mode', async () => {
    mockApi.fetchIntegrationAction.mockResolvedValue(detailOf());
    mockApi.saveIntegrationActionOverride.mockResolvedValue({ detail: detailOf() });
    mockApi.setInstalledIntegrationApproval.mockResolvedValue({});
    renderDrawer();

    await screen.findByTestId('action-effect-sources');
    fireEvent.change(screen.getByLabelText('Side effect override'), {
      target: { value: 'destructive' }
    });
    await waitFor(() =>
      expect(mockApi.saveIntegrationActionOverride).toHaveBeenCalledWith('jira', 'addComment', {
        sideEffect: 'destructive'
      })
    );
    fireEvent.change(screen.getByLabelText('Approval for this action'), {
      target: { value: 'always' }
    });
    await waitFor(() =>
      expect(mockApi.setInstalledIntegrationApproval).toHaveBeenCalledWith('jira', {
        default: 'writes',
        actions: { addComment: 'always' }
      })
    );
  });
});
