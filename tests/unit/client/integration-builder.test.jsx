// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * The integration builder (Admin → Integrations → Add manually, #2975): the
 * pure draft rules, the steps, and the page creating an HTTP request
 * integration end to end against a mocked API.
 */

jest.mock('react-i18next', () => {
  const en = require('../../../shared/i18n/en.json');
  const lookup = key => key.split('.').reduce((node, part) => node?.[part], en);
  const interpolate = (text, options = {}) =>
    Object.entries(options || {}).reduce(
      (out, [name, value]) => out.replaceAll(`{{${name}}}`, String(value)),
      text
    );
  const translate = (key, fallbackOrOptions, maybeOptions) => {
    const options = typeof fallbackOrOptions === 'object' ? fallbackOrOptions : maybeOptions;
    const fallback = typeof fallbackOrOptions === 'string' ? fallbackOrOptions : key;
    const text = typeof lookup(key) === 'string' ? lookup(key) : fallback;
    return interpolate(text, options);
  };
  const translation = { t: translate, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => <span data-testid="icon" />
}));

jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: jest.fn(),
  getAdminApiErrorMessage: err => err?.message || 'error',
  listCredentials: jest.fn(async () => [{ id: 'erp-token', type: 'bearer', name: 'ERP' }])
}));

const mockApi = {
  createCustomIntegration: jest.fn(),
  saveCustomIntegration: jest.fn(),
  fetchBuilderDraft: jest.fn(),
  exportCustomIntegration: jest.fn(),
  importBuilderActions: jest.fn()
};
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  createCustomIntegration: (...args) => mockApi.createCustomIntegration(...args),
  saveCustomIntegration: (...args) => mockApi.saveCustomIntegration(...args),
  fetchBuilderDraft: (...args) => mockApi.fetchBuilderDraft(...args),
  exportCustomIntegration: (...args) => mockApi.exportCustomIntegration(...args),
  importBuilderActions: (...args) => mockApi.importBuilderActions(...args)
}));

jest.mock('../../../client/src/features/admin/hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: () => ({ blocker: { state: 'unblocked' }, markSaved: () => {} })
}));

jest.mock('../../../client/src/features/admin/components/AdminBreadcrumb', () => ({
  __esModule: true,
  default: () => <nav data-testid="breadcrumb" />
}));

// runtimeBasePath uses `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildPath: path => path,
  getBasePath: () => ''
}));

const model = require('../../../client/src/features/admin/components/integrations/builder/builderModel');
const {
  integrationGroupOf
} = require('../../../client/src/features/admin/components/integrations/integrationGroups');
const BuilderBasicsStep =
  require('../../../client/src/features/admin/components/integrations/builder/BuilderBasicsStep').default;
const BuilderActionsStep =
  require('../../../client/src/features/admin/components/integrations/builder/BuilderActionsStep').default;
const BuilderSourceStep =
  require('../../../client/src/features/admin/components/integrations/builder/BuilderSourceStep').default;
const AdminIntegrationBuilderPage =
  require('../../../client/src/features/admin/pages/AdminIntegrationBuilderPage').default;

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
});

describe('builder model', () => {
  it('proposes ids builders accept', () => {
    expect(model.slugify('My ERP: Orders!')).toBe('my-erp-orders');
    expect(model.slugify('Größe')).toBe('grosse');
    expect(model.isValidInstanceId('orders')).toBe(true);
    expect(model.isValidInstanceId('Orders')).toBe(false);
  });

  it('starts a source fresh and keeps only the sign-in it offers', () => {
    const draft = {
      ...model.emptyDraft(),
      auth: { mode: 'service-account', kind: 'credential', credentialRef: 'x' },
      actions: [{ name: 'a' }]
    };
    const next = model.withSource(draft, 'script');
    expect(next.actions).toEqual([]);
    expect(next.http).toBeUndefined();
    expect(next.script).toEqual({ module: '' });
    expect(next.auth.mode).toBe('none');
    expect(model.withSource(draft, 'mcp').auth.kind).toBe('bearer');
  });

  it('turns picked operations into actions with the side effect of their method', () => {
    const ops = [
      { operationId: 'getOrder', method: 'get', summary: 'Get', sideEffect: 'read' },
      { operationId: 'deleteOrder', method: 'delete' }
    ];
    const actions = model.actionsFromOperations(ops, ['getOrder', 'deleteOrder']);
    expect(actions.map(a => [a.name, a.sideEffect])).toEqual([
      ['getOrder', 'read'],
      ['deleteOrder', 'destructive']
    ]);
    // An operation picked before keeps the admin's settings.
    const kept = model.actionsFromOperations(
      ops,
      ['getOrder'],
      [{ ...actions[0], approval: 'always', dataFlow: 'internal' }]
    );
    expect(kept).toEqual([{ ...actions[0], approval: 'always', dataFlow: 'internal' }]);
  });

  it('finds placeholders no parameter declares and adds them', () => {
    const request = { url: '/orders/{id}', query: { q: '{q}' }, body: '{"n": {note}}' };
    const parameters = { type: 'object', properties: { id: { type: 'string' } } };
    expect(model.undeclaredPlaceholders(request, parameters)).toEqual(['q', 'note']);
    const schema = model.parametersFromPlaceholders(request, parameters);
    expect(Object.keys(schema.properties)).toEqual(['id', 'q', 'note']);
    expect(schema.required).toEqual(['id']);
  });

  it('names what each step misses', () => {
    const draft = { ...model.emptyDraft(), instanceId: 'Bad Id' };
    expect(Object.keys(model.stepErrors(draft, 'basics'))).toEqual(['name', 'instanceId']);
    const auth = { ...draft, auth: { mode: 'service-account', kind: 'header' } };
    expect(Object.keys(model.stepErrors(auth, 'signIn'))).toEqual(['credentialRef', 'header']);
    const http = {
      ...draft,
      actions: [{ name: 'a', request: { method: 'GET', url: '/x', body: '{}' } }]
    };
    expect(Object.keys(model.stepErrors(http, 'actions'))).toEqual([
      'actions.0.url',
      'actions.0.body'
    ]);
    expect(model.stepErrors({ ...draft, actions: [] }, 'actions').actions).toBeTruthy();
  });

  it('sends only the current source and no display-only fields', () => {
    const draft = {
      ...model.emptyDraft(),
      instanceId: 'orders',
      name: { en: 'Orders' },
      description: { en: '' },
      source: 'mcp',
      mcp: { transport: 'stdio', command: 'node', args: ['s.js'], url: 'https://x', headers: {} },
      http: { baseUrl: 'https://left.over' },
      actions: [{ name: 'tool', remoteDescription: 'remote', parameters: {}, sideEffect: 'read' }]
    };
    const payload = model.draftForSave(draft);
    expect(payload.http).toBeUndefined();
    expect(payload.description).toBeUndefined();
    expect(payload.mcp).toEqual({ transport: 'stdio', command: 'node', args: ['s.js'] });
    expect(payload.actions).toEqual([{ name: 'tool', sideEffect: 'read' }]);
    expect(payload.auth).toEqual({ mode: 'none' });
  });

  it('writes a stub for every script action', () => {
    const source = model.scriptSkeleton([{ name: 'lookup' }, { name: 'update' }]);
    expect(source).toContain('"lookup": {');
    expect(source).toContain('"update": {');
    expect(model.moduleMentions(source, 'lookup')).toBe(true);
  });

  it('maps a server error path to its step', () => {
    expect(model.stepOfServerPath(['auth', 'credentialRef'])).toBe('signIn');
    expect(model.stepOfServerPath(['actions', 0, 'request'])).toBe('actions');
    expect(model.stepOfServerPath(['http', 'baseUrl'])).toBe('source');
  });

  it('groups custom integrations under Custom, MCP ones under MCP servers', () => {
    expect(
      integrationGroupOf({ id: 'orders', definition: 'custom/orders', protocol: 'http' })
    ).toBe('custom');
    expect(integrationGroupOf({ id: 'custom/orders', protocol: 'script' })).toBe('custom');
    expect(integrationGroupOf({ id: 'x', definition: 'custom/x', protocol: 'mcp' })).toBe('mcp');
  });
});

describe('builder steps', () => {
  it('proposes the id from the name while the integration is new', () => {
    const onChange = jest.fn();
    render(<BuilderBasicsStep draft={model.emptyDraft()} onChange={onChange} isNew errors={{}} />);
    const nameInput = screen.getAllByRole('textbox')[0];
    fireEvent.change(nameInput, { target: { value: 'ERP Orders' } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ instanceId: 'erp-orders' })
    );
  });

  it('keeps the id of a saved integration', () => {
    render(
      <BuilderBasicsStep
        draft={{ ...model.emptyDraft(), instanceId: 'orders' }}
        onChange={() => {}}
        isNew={false}
        errors={{}}
      />
    );
    expect(screen.getByDisplayValue('orders')).toBeDisabled();
  });

  it('adds HTTP actions and suggests the side effect of the method', () => {
    let draft = { ...model.emptyDraft(), instanceId: 'orders' };
    const onChange = jest.fn(patch => {
      draft = { ...draft, ...patch };
    });
    const { rerender } = render(
      <BuilderActionsStep draft={draft} onChange={onChange} errors={{}} />
    );
    fireEvent.click(screen.getByRole('button', { name: /Add action/ }));
    rerender(<BuilderActionsStep draft={draft} onChange={onChange} errors={{}} />);
    expect(draft.actions).toHaveLength(1);
    expect(draft.actions[0].sideEffect).toBe('read');
    fireEvent.change(screen.getByLabelText('Method'), { target: { value: 'DELETE' } });
    expect(draft.actions[0].sideEffect).toBe('destructive');
    expect(draft.actions[0].request.method).toBe('DELETE');
  });

  it('stops a description at the length the server accepts', () => {
    const draft = {
      ...model.emptyDraft(),
      instanceId: 'orders',
      actions: [
        { ...model.emptyHttpAction([]), name: 'get_order', description: { en: 'Get one order' } }
      ]
    };
    render(<BuilderActionsStep draft={draft} onChange={() => {}} errors={{}} />);
    const field = screen.getByLabelText('Description for the model (EN)');
    expect(field).toHaveAttribute('maxlength', String(model.MAX_ACTION_DESCRIPTION_LENGTH));
    expect(model.MAX_ACTION_DESCRIPTION_LENGTH).toBe(4000);
  });

  it('lists an MCP server’s tools as actions', async () => {
    mockApi.importBuilderActions.mockResolvedValue({
      success: true,
      actions: [{ name: 'search', description: 'Searches', parameters: { type: 'object' } }]
    });
    let draft = {
      ...model.withSource(model.emptyDraft(), 'mcp'),
      instanceId: 'docs',
      mcp: { transport: 'streamableHttp', url: 'https://mcp.example.com/mcp', headers: {} }
    };
    const onChange = patch => {
      draft = { ...draft, ...patch };
    };
    render(<BuilderActionsStep draft={draft} onChange={onChange} errors={{}} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /List the server/ }));
    });
    expect(mockApi.importBuilderActions).toHaveBeenCalledWith({
      kind: 'mcp',
      source: { transport: 'streamableHttp', url: 'https://mcp.example.com/mcp', headers: {} },
      auth: { mode: 'none' }
    });
    expect(draft.actions).toEqual([
      expect.objectContaining({ name: 'search', remoteDescription: 'Searches' })
    ]);
  });

  it('offers every source as a radio and asks before dropping actions', () => {
    const onSourceChange = jest.fn();
    render(
      <MemoryRouter>
        <BuilderSourceStep
          draft={model.emptyDraft()}
          onChange={() => {}}
          onSourceChange={onSourceChange}
          errors={{}}
        />
      </MemoryRouter>
    );
    const group = screen.getByRole('group', { name: 'Where the actions come from' });
    expect(within(group).getAllByRole('radio')).toHaveLength(5);
    fireEvent.click(within(group).getByLabelText(/Script/));
    expect(onSourceChange).toHaveBeenCalledWith('script');
  });
});

describe('builder page', () => {
  function renderPage(path = '/admin/integrations/builder/new') {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/admin/integrations/builder/:instanceId"
            element={<AdminIntegrationBuilderPage />}
          />
          <Route path="/admin/integrations/:instanceId" element={<p>installation page</p>} />
        </Routes>
      </MemoryRouter>
    );
  }

  it('walks the steps, refuses an incomplete one and creates the integration', async () => {
    mockApi.createCustomIntegration.mockResolvedValue({ instance: { id: 'orders' } });
    renderPage();
    // Basics: Next is refused without a name.
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(screen.getByText('Give the integration a name.')).toBeInTheDocument();
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'Orders' } });
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    // Sign-in: none.
    expect(screen.getByRole('radio', { name: /None/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    // Source: HTTP request is preselected.
    fireEvent.change(screen.getByLabelText(/Base URL/), {
      target: { value: 'https://erp.example.com/api' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    // Actions: one GET action.
    fireEvent.click(screen.getByRole('button', { name: /Add action/ }));
    fireEvent.change(screen.getByLabelText('URL template'), {
      target: { value: '/orders/{id}' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Add them as parameters/ }));
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    // Review, then create.
    expect(screen.getByText('orders__action_1')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Create integration/ }));
    });
    const payload = mockApi.createCustomIntegration.mock.calls[0][0];
    expect(payload).toMatchObject({
      instanceId: 'orders',
      source: 'http',
      http: { baseUrl: 'https://erp.example.com/api' },
      auth: { mode: 'none' }
    });
    expect(payload.actions[0]).toMatchObject({
      name: 'action_1',
      request: { method: 'GET', url: '/orders/{id}' },
      parameters: { required: ['id'] }
    });
    expect(screen.getByText('installation page')).toBeInTheDocument();
  });

  it('opens a saved integration, keeps its id and saves it', async () => {
    mockApi.fetchBuilderDraft.mockResolvedValue({
      instanceId: 'legacy',
      definitionId: 'custom/legacy',
      name: { en: 'Legacy' },
      source: 'script',
      auth: { mode: 'none' },
      script: { module: 'export default { actions: {} };' },
      actions: [
        { name: 'lookup', toolId: 'legacyLookup', sideEffect: 'read', dataFlow: 'internal' }
      ]
    });
    mockApi.saveCustomIntegration.mockResolvedValue({ instance: { id: 'legacy' } });
    await act(async () => {
      renderPage('/admin/integrations/builder/legacy');
    });
    expect(screen.getByDisplayValue('legacy')).toBeDisabled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    });
    expect(mockApi.saveCustomIntegration).toHaveBeenCalledWith(
      'legacy',
      expect.objectContaining({
        definitionId: 'custom/legacy',
        actions: [expect.objectContaining({ toolId: 'legacyLookup' })]
      })
    );
  });

  it('shows the server’s refusal and jumps to the step it names', async () => {
    mockApi.fetchBuilderDraft.mockResolvedValue({
      instanceId: 'orders',
      name: { en: 'Orders' },
      source: 'http',
      auth: { mode: 'none' },
      http: { baseUrl: 'https://erp.example.com' },
      actions: [{ name: 'a', request: { method: 'GET', url: '/a' }, sideEffect: 'read' }]
    });
    const error = Object.assign(new Error('The integration is not valid'), {
      response: { data: { details: [{ path: ['auth', 'credentialRef'], message: 'missing' }] } }
    });
    mockApi.saveCustomIntegration.mockRejectedValue(error);
    await act(async () => {
      renderPage('/admin/integrations/builder/orders');
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('auth.credentialRef');
    expect(screen.getByRole('tab', { name: 'Sign-in' })).toHaveAttribute('aria-selected', 'true');
  });
});
