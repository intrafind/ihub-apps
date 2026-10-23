// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * The chat input of an app outside the app (`AppChatStarter`), shared by the
 * start page and the project page: it starts the chat in the app with the
 * caller's query parameters, runs the caller's hook right before, and
 * refuses a message the start link could not carry. The `+` menu features
 * are covered in start-page-chat-features.test.jsx.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue) => defaultValue ?? key,
    i18n: { language: 'en' }
  })
}));

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate
}));

const mockApp = {
  id: 'chat',
  name: { en: 'Chat' },
  description: { en: 'General chat' },
  color: '#4f46e5',
  icon: 'chat',
  tools: ['braveSearch', 'jira'],
  websearch: { enabled: true, enabledByDefault: false },
  features: { magicPrompt: { enabled: true } }
};

const mockModelList = [{ id: 'gpt', name: { en: 'GPT' } }];

jest.mock('../../../client/src/api', () => ({
  fetchAppDetails: jest.fn(() => Promise.resolve(mockApp)),
  fetchModels: jest.fn(() => Promise.resolve(mockModelList)),
  // The server localizes tool metadata, so names arrive as plain strings.
  fetchToolsBasic: jest.fn(() =>
    Promise.resolve([
      { id: 'braveSearch', name: 'Brave Search' },
      { id: 'jira', name: 'Jira' }
    ])
  ),
  generateMagicPrompt: jest.fn(() => Promise.resolve({ prompt: 'enhanced' }))
}));

jest.mock('../../../client/src/shared/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Ada' } })
}));

jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  useUIConfig: () => ({ uiConfig: {}, resetHeaderColor: jest.fn(), setHeaderColor: jest.fn() })
}));

jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: { features: {} } })
}));

jest.mock('../../../client/src/shared/hooks/useApps', () => ({
  __esModule: true,
  default: () => ({ apps: [{ id: 'chat', name: { en: 'Chat' }, icon: 'chat' }], loading: false })
}));

jest.mock('../../../client/src/shared/hooks/useAuthKey', () => ({
  __esModule: true,
  default: () => 'anon'
}));

jest.mock('../../../client/src/shared/hooks/useFavorites', () => ({
  __esModule: true,
  default: () => ({ favorites: [] })
}));

// `runtimeBasePath` reads `import.meta.env`, which the CJS test transform
// cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildAssetUrl: path => path,
  getBasePath: () => '',
  KNOWN_ROUTES: []
}));

// Leaf components that reach for browser APIs jsdom does not provide.
jest.mock('../../../client/src/features/voice/components', () => ({
  VoiceInputComponent: () => null
}));
jest.mock('../../../client/src/features/prompts/components/PromptSearch', () => () => null);
jest.mock('../../../client/src/features/chat/components/WorkflowMentionSearch', () => () => null);
jest.mock('../../../client/src/features/upload/components', () => ({
  UnifiedUploader: () => null,
  CloudStoragePicker: () => null,
  AttachedFilesList: () => null
}));

const AppChatStarter =
  require('../../../client/src/features/chat/components/AppChatStarter').default;
const {
  MAX_START_PATH_LENGTH
} = require('../../../client/src/features/chat/components/AppChatStarter');
const { consumePendingChatStart } = require('../../../client/src/features/chat/startChatHandoff');

async function renderStarter(props = {}) {
  const utils = render(<AppChatStarter app={{ id: 'chat' }} {...props} />);
  await waitFor(() => expect(screen.getByRole('textbox')).toBeInTheDocument());
  return utils;
}

async function send(text) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
  await act(async () => {
    fireEvent.submit(screen.getByRole('textbox').closest('form'));
  });
}

beforeEach(() => {
  mockNavigate.mockClear();
  sessionStorage.clear();
  consumePendingChatStart('chat');
});

it('starts the chat with the caller’s parameters and runs its hook first', async () => {
  const onBeforeStart = jest.fn(() => expect(mockNavigate).not.toHaveBeenCalled());
  await renderStarter({ startParams: { project: 'prj_case' }, onBeforeStart });

  await send('Summarize the lease');

  expect(onBeforeStart).toHaveBeenCalledWith('chat');
  expect(mockNavigate).toHaveBeenCalledWith(
    '/apps/chat?project=prj_case&prefill=Summarize+the+lease&send=true'
  );
  expect(consumePendingChatStart('chat')).toMatchObject({ appId: 'chat' });
});

it('shows an error when the link would be too long, and starts nothing', async () => {
  const onBeforeStart = jest.fn();
  await renderStarter({ onBeforeStart });

  await send('x'.repeat(MAX_START_PATH_LENGTH));

  expect(screen.getByRole('alert')).toHaveTextContent(
    'This message is too long to send from here.'
  );
  expect(mockNavigate).not.toHaveBeenCalled();
  expect(onBeforeStart).not.toHaveBeenCalled();

  // Editing clears the error; about 7,000 characters of ordinary text go out.
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'word' } });
  expect(screen.queryByRole('alert')).toBeNull();
  await send('word '.repeat(1400).trim());
  expect(mockNavigate).toHaveBeenCalledTimes(1);
});
