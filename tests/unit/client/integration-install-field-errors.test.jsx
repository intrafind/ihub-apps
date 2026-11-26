// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';
import problem from '../../contract/problem-validation.json';
import {
  mapProblemErrorsToFields,
  pointerSegments
} from '../../../client/src/utils/mapProblemErrorsToFields';

/**
 * Validation failures reach their fields (IN-B4).
 *
 * The server answers a failed install or test with problem+json whose
 * `errors[]` name each field by JSON Pointer (`/values/baseUrl`);
 * `tests/contract/problem-validation.json` is that answer, produced by the
 * real serializer (server/tests/problem-json-validation-shape.test.js). The
 * form used to read `details.issues`, which the serializer never sends, so
 * the admin saw only "Invalid install values".
 *
 * Also covered: an integration installed once proposes and locks its fixed id
 * (IN-B2), and a sign-in mode the server lists as supported is offered, not
 * shown as "(later release)" (IN-B5).
 */

/** `t` over the shipped English catalog, as the app resolves it. */
function lookup(key) {
  return key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), en);
}
const mockT = (key, options) => {
  const found = lookup(key);
  if (typeof found === 'string') {
    return found.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''));
  }
  if (typeof options === 'string') return options;
  return options?.defaultValue ?? key;
};
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } })
}));

const mockApi = { fetchIntegrationDefinition: jest.fn(), testIntegrationDraft: jest.fn() };
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  fetchInstalledIntegration: jest.fn(),
  fetchIntegrationDefinition: (...args) => mockApi.fetchIntegrationDefinition(...args),
  installIntegration: jest.fn(),
  testIntegrationDraft: (...args) => mockApi.testIntegrationDraft(...args),
  updateInstalledIntegration: jest.fn()
}));
jest.mock('../../../client/src/api/adminApi', () => ({
  fetchAdminGroups: jest.fn().mockResolvedValue({ groups: {} }),
  getAdminApiErrorMessage: err => err?.response?.data?.detail || err?.message || 'error',
  makeAdminApiCall: jest.fn(),
  listCredentials: jest.fn().mockResolvedValue([])
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({ getBasePath: () => '' }));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/IntegrationTestResults', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/OpenApiToolEditor', () => ({
  CredentialRefSelect: () => null
}));

const IntegrationInstallForm =
  require('../../../client/src/features/admin/components/integrations/IntegrationInstallForm').default;

describe('mapProblemErrorsToFields', () => {
  test('keys each entry by its pointer below the prefix', () => {
    expect(mapProblemErrorsToFields(problem, { prefix: '/values' })).toEqual({
      baseUrl: 'required',
      maxRows: 'must be at most 50'
    });
  });

  test('reads the problem from a rejected axios request too', () => {
    const err = { response: { data: problem } };
    expect(Object.keys(mapProblemErrorsToFields(err, { prefix: '/values' }))).toEqual([
      'baseUrl',
      'maxRows'
    ]);
  });

  test('without a prefix, keys by the dotted path', () => {
    expect(mapProblemErrorsToFields(problem)).toMatchObject({ 'values.baseUrl': 'required' });
  });

  test('localizes a known code; a limit code without the field limit keeps the server message', () => {
    expect(mapProblemErrorsToFields(problem, { prefix: '/values', t: mockT })).toEqual({
      baseUrl: 'Required.',
      maxRows: 'must be at most 50'
    });
  });

  test('localizes TOO_LARGE / TOO_SMALL with the limit the form knows (R3)', () => {
    const limitsOf = field => (field === 'maxRows' ? { min: 1, max: 50 } : {});
    expect(mapProblemErrorsToFields(problem, { prefix: '/values', t: mockT, limitsOf })).toEqual({
      baseUrl: 'Required.',
      maxRows: 'Enter 50 or less.'
    });
    const small = { errors: [{ pointer: '/values/maxRows', code: 'TOO_SMALL', message: 'x' }] };
    expect(mapProblemErrorsToFields(small, { prefix: '/values', t: mockT, limitsOf })).toEqual({
      maxRows: 'Enter 1 or more.'
    });
  });

  test('both catalogs translate TOO_SMALL and TOO_LARGE with their limit (R3)', () => {
    for (const catalog of [en, de]) {
      expect(catalog.errors.fields.TOO_SMALL).toContain('{{min}}');
      expect(catalog.errors.fields.TOO_LARGE).toContain('{{max}}');
    }
  });

  test('skips entries outside the prefix and answers {} without errors', () => {
    const other = { errors: [{ pointer: '/auth/mode', code: 'INVALID', message: 'bad' }] };
    expect(mapProblemErrorsToFields(other, { prefix: '/values' })).toEqual({});
    expect(mapProblemErrorsToFields({ code: 'NOT_FOUND' })).toEqual({});
    expect(mapProblemErrorsToFields(undefined)).toEqual({});
  });

  test('unescapes RFC 6901 pointers', () => {
    expect(pointerSegments('/a~1b/c~0d')).toEqual(['a/b', 'c~d']);
    expect(pointerSegments('')).toEqual([]);
  });
});

const PORTAL = {
  id: 'org.example/portal',
  name: 'Portal',
  protocol: 'openapi',
  supported: true,
  singleton: null,
  authModes: ['none'],
  supportedAuthModes: ['none', 'service-account'],
  defaultAuthMode: 'none',
  actions: [],
  install: [
    { key: 'baseUrl', type: 'url', scope: 'admin', required: true, title: { en: 'Portal URL' } },
    { key: 'maxRows', type: 'number', scope: 'admin', max: 50, title: { en: 'Rows' } }
  ]
};

function renderForm() {
  return render(
    <MemoryRouter>
      <IntegrationInstallForm
        definitionId="org.example/portal"
        variant="page"
        onCancel={() => {}}
        onSaved={() => {}}
      />
    </MemoryRouter>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('a failed test shows each server error at its field (IN-B4)', async () => {
  mockApi.fetchIntegrationDefinition.mockResolvedValue(PORTAL);
  mockApi.testIntegrationDraft.mockRejectedValue({ response: { status: 400, data: problem } });
  renderForm();
  const url = await screen.findByLabelText(/Portal URL/);
  fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

  await waitFor(() => expect(url).toHaveAttribute('aria-invalid', 'true'));
  expect(within(url.parentElement).getByRole('alert')).toHaveTextContent('Required.');
  const rows = screen.getByLabelText('Rows');
  expect(rows).toHaveAttribute('aria-invalid', 'true');
  // Localized, with the limit from the definition (R3).
  expect(within(rows.parentElement).getByRole('alert')).toHaveTextContent('Enter 50 or less.');
  // The summary says what kind of failure it is, without repeating the field errors.
  expect(screen.getByText('Some of the entered values are not valid.')).toBeInTheDocument();

  // Typing in a field clears its error.
  fireEvent.change(url, { target: { value: 'https://portal.example' } });
  expect(url).not.toHaveAttribute('aria-invalid');
});

test('an integration installed once proposes its fixed id and locks it (IN-B2)', async () => {
  mockApi.fetchIntegrationDefinition.mockResolvedValue({
    ...PORTAL,
    id: 'com.intrafind/brave-search',
    singleton: { instanceId: 'brave' }
  });
  renderForm();
  const id = await screen.findByLabelText('ID');
  expect(id).toHaveValue('brave');
  expect(id).toBeDisabled();
});

test('a sign-in mode the server supports is offered, not "(later release)" (IN-B5)', async () => {
  mockApi.fetchIntegrationDefinition.mockResolvedValue({
    ...PORTAL,
    id: 'com.intrafind/jira',
    protocol: 'native',
    authModes: ['oauth-user'],
    supportedAuthModes: ['oauth-user'],
    defaultAuthMode: null,
    install: []
  });
  renderForm();
  const radio = await screen.findByRole('radio', { name: /Each user signs in/ });
  expect(radio).toBeEnabled();
  expect(radio).toBeChecked();
  expect(screen.queryByText('(later release)')).not.toBeInTheDocument();
});

describe('the MCP question switch (elicitation)', () => {
  const {
    elicitationPayload
  } = require('../../../client/src/features/admin/components/integrations/IntegrationInstallForm');
  const MCP = {
    ...PORTAL,
    id: 'com.intrafind/mcp-server',
    name: 'MCP server',
    protocol: 'mcp',
    elicitationDefault: true,
    install: []
  };

  test('stores nothing while the form shows the definition default', () => {
    expect(elicitationPayload(MCP, { elicitationEnabled: true, storedElicitation: null })).toEqual(
      {}
    );
    expect(
      elicitationPayload({ ...MCP, elicitationDefault: false }, { elicitationEnabled: false })
    ).toEqual({});
    expect(elicitationPayload(PORTAL, { elicitationEnabled: false })).toEqual({});
  });

  test("stores the admin's choice, and keeps a stored one", () => {
    expect(elicitationPayload(MCP, { elicitationEnabled: false })).toEqual({
      elicitation: { enabled: false }
    });
    expect(
      elicitationPayload(MCP, { elicitationEnabled: true, storedElicitation: { enabled: false } })
    ).toEqual({ elicitation: { enabled: true } });
  });

  test('is offered for an MCP server only and sent when switched off', async () => {
    mockApi.fetchIntegrationDefinition.mockResolvedValue(MCP);
    mockApi.testIntegrationDraft.mockResolvedValue({ ok: true });
    renderForm();
    const box = await screen.findByLabelText(/ask chat users questions/i);
    expect(box).toBeChecked();
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(mockApi.testIntegrationDraft).toHaveBeenCalled());
    expect(JSON.stringify(mockApi.testIntegrationDraft.mock.calls[0])).toContain(
      '"elicitation":{"enabled":false}'
    );
  });

  test('is not offered for another protocol', async () => {
    mockApi.fetchIntegrationDefinition.mockResolvedValue(PORTAL);
    renderForm();
    await screen.findByLabelText(/Portal URL/);
    expect(screen.queryByLabelText(/ask chat users questions/i)).not.toBeInTheDocument();
  });
});
