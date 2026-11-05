// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The chat of a project test (#3309, `TestChat` with `testProjectId`): the app
 * is run as saved, but incognito with no way out of it — switching incognito
 * off after the first turn would keep the scratch chat in the admin's history
 * — and with the model picker on. Without a project the chat is the app
 * editor's and the integration test's, unchanged.
 */
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockApi = { fetchAppDetails: jest.fn() };
jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  fetchAppDetails: (...args) => mockApi.fetchAppDetails(...args)
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  __esModule: true,
  buildPath: path => path
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) })
}));
// The real chat is AppChat's own business; here it shows what it is handed.
const mockChat = { props: null };
jest.mock('../../../client/src/features/apps/pages/AppChat', () => ({
  __esModule: true,
  default: props => {
    mockChat.props = props;
    return <div data-testid="app-chat" />;
  }
}));

const {
  TestChat,
  projectTestApp
} = require('../../../client/src/features/admin/components/AppTestPanel');

const SAVED = {
  id: 'support',
  type: 'chat',
  ephemeral: false,
  disallowModelSelection: true,
  settings: {
    model: { enabled: false, filter: { supportsTools: true } },
    ephemeral: { enabled: true, note: 'kept' },
    style: { enabled: false }
  }
};

beforeEach(() => {
  mockChat.props = null;
  mockApi.fetchAppDetails.mockReset();
  mockApi.fetchAppDetails.mockResolvedValue(SAVED);
});

describe('projectTestApp', () => {
  test('runs the app incognito and takes the toggle away, so the chat cannot be kept', () => {
    const app = projectTestApp(SAVED);
    expect(app.ephemeral).toBe(true);
    expect(app.settings.ephemeral.enabled).toBe(false);
  });

  test('turns the model picker on whatever the app says, and keeps its other settings', () => {
    const app = projectTestApp(SAVED);
    expect(app.disallowModelSelection).toBe(false);
    expect(app.settings.model.enabled).toBe(true);
    expect(app.settings.model.filter).toEqual({ supportsTools: true });
    expect(app.settings.style).toEqual({ enabled: false });
    expect(app.settings.ephemeral.note).toBe('kept');
    expect(app.id).toBe('support');
  });

  test('copes with an app that has no settings and never changes the saved one', () => {
    const bare = { id: 'bare' };
    const app = projectTestApp(bare);
    expect(app.settings.ephemeral.enabled).toBe(false);
    expect(app.settings.model.enabled).toBe(true);
    expect(bare).toEqual({ id: 'bare' });
    const before = JSON.stringify(SAVED);
    projectTestApp(SAVED);
    expect(JSON.stringify(SAVED)).toBe(before);
  });
});

describe('TestChat', () => {
  test('with a project, hands the embedded chat the incognito app and the project', async () => {
    render(<TestChat appId="support" testProjectId="handbook" />);
    await screen.findByTestId('app-chat');

    expect(mockChat.props.embedded).toBe(true);
    expect(mockChat.props.appId).toBe('support');
    expect(mockChat.props.testProjectId).toBe('handbook');
    expect(mockChat.props.preloadedApp.ephemeral).toBe(true);
    expect(mockChat.props.preloadedApp.settings.ephemeral.enabled).toBe(false);
  });

  test('without a project, runs the app exactly as saved', async () => {
    render(<TestChat appId="support" />);
    await screen.findByTestId('app-chat');

    expect(mockChat.props.preloadedApp).toBe(SAVED);
    expect(mockChat.props.testProjectId).toBeNull();
  });

  test('does not run an app that is not a chat app', async () => {
    mockApi.fetchAppDetails.mockResolvedValue({ ...SAVED, type: 'iframe' });
    render(<TestChat appId="site" testProjectId="handbook" />);
    await waitFor(() => expect(screen.queryByTestId('app-chat')).toBeNull());
    expect(await screen.findByText(/Testing here works for chat apps/)).toBeInTheDocument();
  });
});
