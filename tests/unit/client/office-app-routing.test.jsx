import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom';

/**
 * Where the Outlook task pane lands after sign-in (issue #2368): the start
 * page by default, the app list when the admin picked it — and a chat that was
 * left open in this session stays open either way.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue) => (typeof defaultValue === 'string' ? defaultValue : key),
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/features/office/api/officeAuth', () => ({
  OFFICE_TOKEN_KEY: 'office_ihubtoken',
  storeTokenResponse: jest.fn(),
  clearTokens: jest.fn(),
  fetchUserInfo: jest.fn(),
  setOnSessionExpired: jest.fn()
}));

let mockOfficeConfig = {};
jest.mock('../../../client/src/features/office/contexts/OfficeConfigContext', () => ({
  useOfficeConfig: () => mockOfficeConfig
}));

jest.mock('../../../client/src/features/office/components/OfficeLogin', () => ({
  __esModule: true,
  default: () => <div>LOGIN</div>
}));
jest.mock('../../../client/src/features/office/components/OfficeStartPage', () => ({
  __esModule: true,
  default: () => <div>START PAGE</div>
}));
jest.mock('../../../client/src/features/office/components/OfficeChatPanel', () => ({
  __esModule: true,
  default: ({ selectedApp, homePath }) => (
    <div>
      CHAT {selectedApp?.id} home={homePath}
    </div>
  )
}));
jest.mock('../../../client/src/shared/components/AppListPanel', () => ({
  __esModule: true,
  default: ({ header }) => (
    <div>
      {header}
      APP LIST
    </div>
  )
}));

const OfficeApp = require('../../../client/src/features/office/components/OfficeApp').default;

const renderApp = () =>
  render(
    <MemoryRouter>
      <OfficeApp />
    </MemoryRouter>
  );

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  mockOfficeConfig = {};
});

test('signed out: the login screen, whatever the setting', () => {
  mockOfficeConfig = { startPage: { defaultPage: 'apps' } };
  renderApp();
  expect(screen.getByText('LOGIN')).toBeInTheDocument();
});

test('signed in: the start page is home by default', () => {
  localStorage.setItem('office_ihubtoken', 'token');
  renderApp();
  expect(screen.getByText('START PAGE')).toBeInTheDocument();
});

test('signed in: the app list is home when the admin picked it, with no way "back"', () => {
  localStorage.setItem('office_ihubtoken', 'token');
  mockOfficeConfig = { startPage: { defaultPage: 'apps' } };
  renderApp();
  expect(screen.getByText('APP LIST')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Back to start page' })).not.toBeInTheDocument();
});

test('an app left open in this session stays open and its back button leads home', () => {
  localStorage.setItem('office_ihubtoken', 'token');
  sessionStorage.setItem('office_ihubselectedapp', JSON.stringify({ id: 'chat' }));
  renderApp();
  expect(screen.getByText(/CHAT chat home=\/start/)).toBeInTheDocument();
});
