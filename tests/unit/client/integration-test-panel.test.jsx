// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The chat test of an installation (#3128, `IntegrationTestPanel`):
 *
 *   - with apps that use the installation it runs the first enabled chat app
 *     and offers the others in a picker;
 *   - without one it offers the example app, creates it with the id and
 *     availability the admin chose, and then runs it;
 *   - it says when the installation is disabled or the admin's groups do not
 *     grant it;
 *   - every string comes from shared/i18n/en.json.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';

const mockApi = { fetchExampleApps: jest.fn(), createExampleApp: jest.fn() };
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  fetchExampleApps: (...args) => mockApi.fetchExampleApps(...args),
  createExampleApp: (...args) => mockApi.createExampleApp(...args)
}));
jest.mock('../../../client/src/api/adminApi', () => ({
  getAdminApiErrorMessage: err => err?.message || 'error'
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildPath: path => path
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
// The real chat is the app editor's; here it only shows which app it runs.
jest.mock('../../../client/src/features/admin/components/AppTestPanel', () => ({
  TestChat: ({ appId }) => <div data-testid="test-chat">{appId}</div>,
  PanelMessage: ({ children }) => <div data-testid="panel-message">{children}</div>
}));

const mockI18n = i18next.createInstance();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockI18n.t.bind(mockI18n), i18n: mockI18n })
}));

const IntegrationTestPanel =
  require('../../../client/src/features/admin/components/integrations/IntegrationTestPanel').default;
const {
  testableApps
} = require('../../../client/src/features/admin/components/integrations/IntegrationTestPanel');

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en } },
    parseMissingKeyHandler: key => `MISSING:${key}`,
    saveMissing: false
  });
});

const TEMPLATE = {
  key: 'apps/open-data-assistant.json',
  source: 'definition',
  templateId: 'open-data-assistant',
  name: 'Open Data Assistant',
  description: 'Find open datasets',
  icon: 'chart-bar',
  color: '#0F766E',
  suggestedId: 'open-data-assistant'
};

const INSTANCE = { id: 'govdata', label: 'GovData', enabled: true };

function renderPanel(props = {}) {
  const onAppCreated = jest.fn();
  const utils = render(
    <MemoryRouter>
      <IntegrationTestPanel
        instance={INSTANCE}
        boundApps={[]}
        apps={[]}
        reloadKey={0}
        onAppCreated={onAppCreated}
        onClose={jest.fn()}
        {...props}
      />
    </MemoryRouter>
  );
  return { ...utils, onAppCreated };
}

beforeEach(() => {
  mockApi.fetchExampleApps.mockReset();
  mockApi.createExampleApp.mockReset();
  mockApi.fetchExampleApps.mockResolvedValue({
    templates: [TEMPLATE],
    grantedToYou: true,
    enabled: true
  });
});

describe('testableApps', () => {
  it('keeps chat apps, enabled ones first', () => {
    const apps = [{ id: 'off', enabled: false }, { id: 'frame', type: 'iframe' }, { id: 'on' }];
    const bound = apps.map(app => ({ id: app.id, name: app.id }));
    expect(testableApps(bound, apps).map(entry => entry.id)).toEqual(['on', 'off']);
  });
});

describe('IntegrationTestPanel keyboard focus', () => {
  const original = window.matchMedia;
  afterEach(() => {
    window.matchMedia = original;
  });

  function openedFrom() {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    return opener;
  }

  // jsdom has no matchMedia, which the hook reads as "below lg": the panel covers the page.
  it('is a dialog where it covers the page: focus moves in, Escape closes, focus goes back', async () => {
    const opener = openedFrom();
    const onClose = jest.fn();
    const { unmount } = renderPanel({ onClose });
    const panel = screen.getByTestId('integration-test-panel');

    expect(panel).toHaveAttribute('role', 'dialog');
    expect(panel).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'Close test panel' })).toHaveFocus();

    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    unmount();
    await waitFor(() => expect(opener).toHaveFocus());
    opener.remove();
  });

  it('is a plain side panel beside the page: no dialog, no focus taken, Escape left alone', () => {
    window.matchMedia = () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {}
    });
    const opener = openedFrom();
    const onClose = jest.fn();
    renderPanel({ onClose });
    const panel = screen.getByTestId('integration-test-panel');

    expect(panel).not.toHaveAttribute('role');
    expect(panel).not.toHaveAttribute('aria-modal');
    expect(opener).toHaveFocus();
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    opener.remove();
  });
});

describe('IntegrationTestPanel', () => {
  it('runs the first enabled app that uses the installation', async () => {
    renderPanel({
      boundApps: [
        { id: 'off-app', name: 'Off app' },
        { id: 'open-data', name: 'Open data' }
      ],
      apps: [{ id: 'off-app', enabled: false }, { id: 'open-data' }]
    });
    expect(await screen.findByTestId('test-chat')).toHaveTextContent('open-data');
    const select = screen.getByTestId('test-app-select');
    expect(screen.getByRole('option', { name: 'Off app (disabled)' })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'off-app' } });
    expect(screen.queryByTestId('test-chat')).not.toBeInTheDocument();
    expect(screen.getByTestId('panel-message')).toHaveTextContent(/This app is disabled/);
    expect(document.body).not.toHaveTextContent('MISSING:');
  });

  it('offers the example app when no app uses the installation, and runs it once created', async () => {
    mockApi.createExampleApp.mockResolvedValue({ id: 'my-open-data', enabled: false });
    const { onAppCreated } = renderPanel();
    expect(await screen.findByTestId('example-app-template')).toHaveTextContent(
      'Open Data Assistant'
    );
    expect(screen.getByText('Ships with the integration')).toBeInTheDocument();
    const idInput = screen.getByLabelText('App id');
    expect(idInput).toHaveValue('open-data-assistant');
    fireEvent.change(idInput, { target: { value: 'my-open-data' } });
    fireEvent.click(screen.getByLabelText('Available to users now'));
    fireEvent.click(screen.getByRole('button', { name: 'Create app' }));
    await waitFor(() =>
      expect(mockApi.createExampleApp).toHaveBeenCalledWith('govdata', {
        template: 'apps/open-data-assistant.json',
        appId: 'my-open-data',
        enabled: false
      })
    );
    await waitFor(() => expect(onAppCreated).toHaveBeenCalled());
    // Created disabled: the panel says how to test it.
    expect(await screen.findByTestId('panel-message')).toHaveTextContent(/This app is disabled/);
    expect(document.body).not.toHaveTextContent('MISSING:');
  });

  it('refuses an invalid app id before asking the server', async () => {
    renderPanel();
    const idInput = await screen.findByLabelText('App id');
    fireEvent.change(idInput, { target: { value: 'Bad Id' } });
    expect(screen.getByRole('button', { name: 'Create and test' })).toBeDisabled();
  });

  it('shows the server error of a failed create', async () => {
    mockApi.createExampleApp.mockRejectedValue(new Error('App with this ID already exists'));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Create and test' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('App with this ID already exists');
  });

  it('says when the installation is disabled or not granted to the admin', async () => {
    mockApi.fetchExampleApps.mockResolvedValue({
      templates: [TEMPLATE],
      grantedToYou: false,
      enabled: false
    });
    renderPanel({ instance: { ...INSTANCE, enabled: false } });
    expect(
      await screen.findByText(/Your groups do not grant this installation/)
    ).toBeInTheDocument();
    expect(screen.getByText(/This installation is disabled/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open groups' })).toHaveAttribute(
      'href',
      '/admin/groups'
    );
  });
});
