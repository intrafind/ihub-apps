// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The former checkbox ("peer") toggles on the shared Switch (intrafind/ihub-apps#2925):
 * web search and iAssistant settings of the app editor, SSL and CORS
 * settings, the user list's "active" toggle and the workflows' "technical
 * details" toggle. Each is a `role="switch"` named by its visible label (or
 * its former `aria-label`), shows its value in `aria-checked`, and hands the
 * same value to its handler as the checkbox did.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue, options) =>
      typeof defaultValue === 'string'
        ? defaultValue.replace(/\{\{(\w+)\}\}/g, (_, name) => options?.[name] ?? '')
        : key,
    i18n: { language: 'en' }
  })
}));

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args),
  getAdminApiErrorMessage: err => err?.message || 'error'
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

// runtimeBasePath uses `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => '',
  buildPath: path => path,
  buildAssetUrl: path => path
}));

const mockSetShowTechnical = jest.fn();
let mockShowTechnical = false;
jest.mock('../../../client/src/features/workflows/hooks/useTechnicalDetailsToggle', () => ({
  useTechnicalDetailsToggle: () => [mockShowTechnical, mockSetShowTechnical]
}));

const WebSearchSection =
  require('../../../client/src/features/admin/components/app-form/WebSearchSection').default;
const IAssistantSection =
  require('../../../client/src/features/admin/components/app-form/IAssistantSection').default;
const SSLConfig = require('../../../client/src/features/admin/components/SSLConfig').default;
const CorsConfig = require('../../../client/src/features/admin/components/CorsConfig').default;
const AdminUsersPage = require('../../../client/src/features/admin/pages/AdminUsersPage').default;
const TechnicalDetailsToggle =
  require('../../../client/src/features/workflows/components/TechnicalDetailsToggle').default;

beforeEach(() => {
  mockMakeAdminApiCall.mockReset();
  mockSetShowTechnical.mockReset();
  mockShowTechnical = false;
});

describe('WebSearchSection switches', () => {
  /**
   * Renders the section and returns the last app handed to `onChange`.
   *
   * @param {Object} websearch - `app.websearch`
   */
  function renderSection(websearch) {
    const onChange = jest.fn();
    render(
      <MemoryRouter>
        <WebSearchSection app={{ id: 'demo', websearch }} onChange={onChange} engines={[]} />
      </MemoryRouter>
    );
    return { onChange, lastWebsearch: () => onChange.mock.calls.at(-1)[0].websearch };
  }

  it('turns web search on from the "Enable Web Search" switch', () => {
    const { onChange, lastWebsearch } = renderSection({ enabled: false });

    const enable = screen.getByRole('switch', { name: 'Enable Web Search' });
    expect(enable).toHaveAttribute('aria-checked', 'false');
    // Only the main switch while web search is off.
    expect(screen.getAllByRole('switch')).toHaveLength(1);

    fireEvent.click(enable);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(lastWebsearch()).toEqual({ enabled: true });
  });

  it.each([
    ['Use Native Search', 'useNativeSearch', 'true', false],
    ['Extract Content', 'extractContent', 'true', false],
    ['Enabled by Default', 'enabledByDefault', 'false', true],
    ['Required', 'required', 'false', true],
    ['Research in Several Steps', 'researchGuidance', 'true', false]
  ])('"%s" shows its default and writes %s', (name, field, shown, written) => {
    const { onChange, lastWebsearch } = renderSection({ enabled: true });

    const control = screen.getByRole('switch', { name });
    expect(control).toHaveAttribute('aria-checked', shown);
    // The help text under the label describes the switch.
    expect(control).toHaveAttribute('aria-describedby');
    expect(document.getElementById(control.getAttribute('aria-describedby'))).toBeInTheDocument();

    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(lastWebsearch()).toEqual({ enabled: true, [field]: written });
  });

  it('toggles a switch from a click on its label', () => {
    const { onChange, lastWebsearch } = renderSection({ enabled: true, extractContent: false });

    fireEvent.click(screen.getByText('Extract Content'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(lastWebsearch()).toEqual({ enabled: true, extractContent: true });
  });
});

describe('IAssistantSection switch', () => {
  it('turns iAssistant on, named by its label', () => {
    const onChange = jest.fn();
    render(<IAssistantSection app={{ id: 'demo', iassistant: {} }} onChange={onChange} />);

    const control = screen.getByRole('switch', { name: 'Enable iAssistant' });
    expect(control).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].iassistant).toEqual({ enabled: true });
  });
});

describe('SSL and CORS switches', () => {
  it('flips "ignore invalid certificates"', async () => {
    mockMakeAdminApiCall.mockResolvedValue({
      data: { ignoreInvalidCertificates: false, domainWhitelist: [] }
    });
    render(<SSLConfig />);

    const control = await screen.findByRole('switch', {
      name: 'admin.system.ssl.ignoreInvalidCertificates'
    });
    expect(control).toHaveAttribute('id', 'ignoreInvalidCerts');
    expect(control).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(control);
    expect(control).toHaveAttribute('aria-checked', 'true');
  });

  it('flips "Allow Credentials"', async () => {
    mockMakeAdminApiCall.mockResolvedValue({
      data: { origin: [], credentials: true, methods: [], allowedHeaders: [] }
    });
    render(<CorsConfig />);

    const control = await screen.findByRole('switch', { name: 'Allow Credentials' });
    expect(control).toHaveAttribute('id', 'corsCredentials');
    await waitFor(() => expect(control).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(control);
    expect(control).toHaveAttribute('aria-checked', 'false');
  });
});

describe('AdminUsersPage active switch', () => {
  it('toggles a user from the row switch, named by the user', async () => {
    mockMakeAdminApiCall.mockImplementation(async (url, options) => {
      if (!options) {
        return {
          data: {
            users: {
              u1: { id: 'u1', username: 'jdoe', name: 'Jane Doe', active: true, groups: [] }
            }
          }
        };
      }
      return { data: {} };
    });
    render(
      <MemoryRouter>
        <AdminUsersPage />
      </MemoryRouter>
    );

    const control = await screen.findByRole('switch', { name: 'Account active: Jane Doe' });
    expect(control).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(control);
    await waitFor(() =>
      expect(mockMakeAdminApiCall).toHaveBeenCalledWith(
        '/admin/auth/users/u1',
        expect.objectContaining({ method: 'PUT' })
      )
    );
    const putCall = mockMakeAdminApiCall.mock.calls.find(
      ([, options]) => options?.method === 'PUT'
    );
    expect(putCall[1].body.active).toBe(false);
  });
});

describe('TechnicalDetailsToggle', () => {
  it('is a switch named by its visible text and turned on from it', () => {
    render(<TechnicalDetailsToggle />);

    const control = screen.getByRole('switch', { name: 'Show technical details' });
    expect(control).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(screen.getByText('Show technical details'));
    expect(mockSetShowTechnical).toHaveBeenCalledTimes(1);
    expect(mockSetShowTechnical).toHaveBeenCalledWith(true);
  });

  it('turns technical details off again', () => {
    mockShowTechnical = true;
    render(<TechnicalDetailsToggle />);

    const control = screen.getByRole('switch', { name: 'Hide technical details' });
    expect(control).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(control);
    expect(mockSetShowTechnical).toHaveBeenCalledWith(false);
  });
});
