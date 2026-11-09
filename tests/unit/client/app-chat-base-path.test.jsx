// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import fs from 'fs';
import path from 'path';

/**
 * AppChat on a deployment under a base path (`/ihub`), driven through the
 * real `AppChat`.
 *
 * The start page opens the app with `?prefill=…&send=true` (and `?model=…`).
 * AppChat strips those parameters from the address once it has used them. It
 * used to do that with `navigate(window.location.pathname + '?…')`: the browser
 * path already holds the base path and the router adds it again, so the chat
 * landed on `/ihub/ihub/apps/<id>`, a route that does not exist.
 *
 * The mock setup mirrors app-chat-start-form.test.jsx.
 */

jest.mock('uuid', () => ({
  __esModule: true,
  v4: () => `uuid-${(global.__uuidSeq = (global.__uuidSeq || 0) + 1)}`
}));

// Every hook stubbed below returns a *stable* identity: `AppChat` has effects
// keyed on these objects, and a fresh one per render turns them into loops.
const mockT = (key, def, opts) =>
  typeof def === 'string'
    ? def.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(opts?.[name] ?? `{{${name}}}`))
    : key;
const mockTranslation = { t: mockT, i18n: { language: 'en' } };
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => mockTranslation
}));

jest.mock('../../../client/src/utils/debugLog', () => ({
  __esModule: true,
  debugLog: () => {}
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  __esModule: true,
  buildApiUrl: path => `/api/${path}`,
  buildPath: path => path
}));

jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  fetchAppDetails: jest.fn(),
  fetchChat: jest.fn(),
  sendAppChatMessage: jest.fn().mockResolvedValue({})
}));
jest.mock('../../../client/src/api/endpoints/apps', () => ({
  __esModule: true
}));
jest.mock('../../../client/src/api/endpoints/integrationFiles', () => ({
  __esModule: true
}));
// Capture the SSE handler so the test decides when the stream reports itself
// connected — which is when the request is actually made.
const mockStream = { onEvent: null, opened: 0 };
jest.mock('../../../client/src/shared/hooks/useEventSource', () => ({
  __esModule: true,
  default: ({ onEvent }) => {
    mockStream.onEvent = onEvent;
    return {
      initEventSource: () => {
        mockStream.opened += 1;
      },
      detachEventSource: () => {},
      stopEventSource: jest.fn()
    };
  }
}));

// By default a transcript that lives in this tab: every request posts the
// whole history, so what earlier turns carry is visible in the payload.
const mockPersistence = { on: false };
jest.mock('../../../client/src/shared/hooks/useChats', () => ({
  __esModule: true,
  invalidateChatsCache: jest.fn(),
  useChatPersistence: () => mockPersistence.on,
  useChatPersistenceResolving: () => false
}));

const mockNoop = () => {};
const mockSettings = {
  selectedModel: 'model-x',
  selectedStyle: 'normal',
  selectedOutputFormat: 'markdown',
  sendChatHistory: true,
  thinkingEnabled: null,
  thinkingBudget: null,
  thinkingThoughts: null,
  enabledTools: null,
  websearchEnabled: false,
  imageAspectRatio: null,
  imageQuality: null,
  ephemeral: false,
  models: [{ id: 'model-x', name: { en: 'Model X' }, contextWindow: 8192 }],
  styles: {},
  setSelectedModel: mockNoop,
  setSelectedStyle: mockNoop,
  setSelectedOutputFormat: mockNoop,
  setSendChatHistory: mockNoop,
  setThinkingEnabled: mockNoop,
  setThinkingBudget: mockNoop,
  setThinkingThoughts: mockNoop,
  setEnabledTools: mockNoop,
  setWebsearchEnabled: mockNoop,
  setImageAspectRatio: mockNoop,
  setImageQuality: mockNoop,
  setEphemeral: mockNoop,
  modelsLoading: false
};
jest.mock('../../../client/src/shared/hooks/useAppSettings', () => ({
  __esModule: true,
  default: () => mockSettings
}));

// Upload state held in real React state, so a file picked in the form shows up
// in what the page sends.
const mockUpload = { config: { enabled: false, localUploadEnabled: false }, dropped: null };
jest.mock('../../../client/src/shared/hooks/useFileUploadHandler', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: () => {
      const [selectedFile, setSelectedFile] = React.useState(null);
      return React.useMemo(
        () => ({
          selectedFile,
          showUploader: false,
          handleFileSelect: setSelectedFile,
          createUploadConfig: () => mockUpload.config,
          toggleUploader: () => {},
          hideUploader: () => {},
          clearSelectedFile: () => setSelectedFile(null),
          setSelectedFile
        }),
        [selectedFile]
      );
    }
  };
});
// The drop zone itself is covered by the upload suites.
jest.mock('../../../client/src/features/upload/components/UnifiedUploader', () => ({
  __esModule: true,
  default: ({ onFileSelect, children }) => (
    <div data-testid="drop-target">
      <button type="button" onClick={() => onFileSelect(mockUpload.dropped)}>
        drop a file
      </button>
      {children}
    </div>
  )
}));
jest.mock('../../../client/src/features/upload/components/AttachedFilesList', () => ({
  __esModule: true,
  default: ({ files }) => (
    <ul data-testid="attached">
      {files.map(f => (
        <li key={f.fileName}>{f.fileName}</li>
      ))}
    </ul>
  )
}));
const mockMagicPrompt = {
  showUndoMagicPrompt: false,
  magicLoading: false,
  resetMagicPrompt: mockNoop,
  runMagicPrompt: mockNoop,
  undoMagicPrompt: mockNoop
};
jest.mock('../../../client/src/shared/hooks/useMagicPrompt', () => ({
  __esModule: true,
  default: () => mockMagicPrompt
}));
jest.mock(
  '../../../client/src/features/nextcloud-embed/hooks/useNextcloudEmbedAttachments',
  () => ({
    __esModule: true,
    default: () => undefined
  })
);
const mockFeatureFlags = {
  isEnabled: (_flag, fallback = false) => fallback,
  isBothEnabled: (_app, _flag, fallback = false) => fallback,
  isAppFeatureEnabled: (_app, _path, fallback = false) => fallback
};
jest.mock('../../../client/src/shared/hooks/useFeatureFlags', () => ({
  __esModule: true,
  default: () => mockFeatureFlags
}));
// The retry after connecting an integration has its own tests (connect-card.test.jsx).
jest.mock('../../../client/src/features/integrations/connect/useConnectRetry', () => ({
  __esModule: true,
  useConnectRetry: () => {}
}));
const mockVoice = { handleVoiceInput: mockNoop, handleVoiceCommand: mockNoop };
// Voice mode (issue #2868) has its own tests; the chat page only renders its
// button and overlay, so it is switched off here.
jest.mock('../../../client/src/features/voice/hooks/useVoiceModeAvailability', () => ({
  __esModule: true,
  default: () => ({
    available: false,
    reason: 'feature-off',
    settings: { maxSessionMinutes: 30 },
    speech: { service: 'browser', modelId: '' },
    ttsModelId: ''
  })
}));
jest.mock('../../../client/src/features/voice/hooks/useVoiceMode', () => ({
  __esModule: true,
  default: () => ({ active: false, toggle: () => {}, end: () => {} })
}));
jest.mock('../../../client/src/features/voice/components/VoiceModeDock', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/voice/hooks/useVoiceCommands', () => ({
  __esModule: true,
  default: () => mockVoice
}));
jest.mock('../../../client/src/features/chat/startChatHandoff', () => ({
  __esModule: true,
  consumePendingChatStart: jest.fn(() => null)
}));
jest.mock('../../../client/src/shared/utils/tokenEstimatorClient.js', () => ({
  __esModule: true,
  ensureTokenizer: jest.fn().mockResolvedValue(undefined),
  estimateTokensSync: () => 0
}));
jest.mock('../../../client/src/utils/recentApps', () => ({
  __esModule: true,
  recordAppUsage: jest.fn()
}));
jest.mock('../../../client/src/utils/appSettings', () => ({
  __esModule: true,
  saveAppSettings: jest.fn(),
  loadAppSettings: jest.fn(() => null)
}));
jest.mock('../../../client/src/features/upload/utils/fileProcessing', () => ({
  __esModule: true,
  processDocumentFile: jest.fn(),
  decodeAudioFileToBuffer: jest.fn()
}));
jest.mock('../../../client/src/utils/transcribeAudioBuffer', () => ({
  __esModule: true,
  transcribeAudioBuffer: jest.fn()
}));
jest.mock('../../../client/src/utils/audioRecorder', () => ({
  __esModule: true,
  AudioBufferRecorder: class {}
}));

// Child components: only what the assertions read.
jest.mock('../../../client/src/shared/components/LoadingSpinner', () => ({
  __esModule: true,
  default: ({ message }) => <div data-testid="spinner">{message}</div>
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/chat/components/ShareDialog', () => ({
  __esModule: true,
  default: () => null
}));
const mockHeader = { props: null };
jest.mock('../../../client/src/features/apps/components/SharedAppHeader', () => ({
  __esModule: true,
  default: props => {
    mockHeader.props = props;
    return null;
  }
}));
jest.mock('../../../client/src/features/chat/components/AIDisclaimerBanner', () => ({
  __esModule: true,
  default: () => null
}));
// The compare view renders the form it is handed and records what is
// broadcast to its panels.
const mockCompare = { sent: [] };
jest.mock('../../../client/src/features/chat/components/CompareModeView', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: React.forwardRef(function MockCompareModeView({ startForm }, ref) {
      React.useImperativeHandle(ref, () => ({
        sendMessage: message => mockCompare.sent.push(message),
        clearAll: () => {},
        cancelAll: () => {}
      }));
      return <div data-testid="compare-view">{startForm}</div>;
    })
  };
});
jest.mock('../../../client/src/features/chat/components/StarterPromptsView', () => ({
  __esModule: true,
  default: () => <div data-testid="starter-prompts" />
}));
jest.mock('../../../client/src/features/chat/components/GreetingView', () => ({
  __esModule: true,
  default: () => <div data-testid="greeting" />
}));
jest.mock('../../../client/src/features/chat/components/NoMessagesView', () => ({
  __esModule: true,
  default: () => <div data-testid="no-messages" />
}));
const mockMessageList = { props: null };
jest.mock('../../../client/src/features/chat/components/ChatMessageList', () => ({
  __esModule: true,
  default: props => {
    mockMessageList.props = props;
    return <div data-testid="transcript">{props.messages.map(m => m.content).join('|')}</div>;
  }
}));
jest.mock('../../../client/src/features/chat/components/ChatInput', () => ({
  __esModule: true,
  default: ({ formRef, onSubmit, onChange, value }) => (
    <form ref={formRef} onSubmit={onSubmit} data-testid="composer">
      <input data-testid="composer-input" value={value} onChange={onChange} />
    </form>
  )
}));

const AppChat = require('../../../client/src/features/apps/pages/AppChat').default;
const { fetchChat, sendAppChatMessage } = require('../../../client/src/api');

const BASE = '/ihub';

const APP = {
  id: 'acme',
  name: { en: 'Acme' },
  description: { en: 'An app' },
  color: '#4f46e5',
  icon: 'chat',
  system: { en: 'You are helpful.' }
};

/** What the router believes the current path is (base path stripped). */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="router-location">{location.pathname + location.search}</div>;
}

/**
 * Render the app the way the browser has it under `/ihub`: the address bar
 * (`window.location`) holds the base path, the router's own location does not.
 */
function renderUnderBasePath(routerUrl) {
  window.history.replaceState({}, '', `${BASE}${routerUrl}`);
  return render(
    <MemoryRouter basename={BASE} initialEntries={[`${BASE}${routerUrl}`]}>
      <LocationProbe />
      <Routes>
        <Route path="/apps/:appId" element={<AppChat preloadedApp={APP} />} />
        <Route path="/apps/:appId/c/:chatId" element={<AppChat preloadedApp={APP} />} />
        <Route path="*" element={<div data-testid="no-route" />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockStream.onEvent = null;
  mockStream.opened = 0;
  mockHeader.props = null;
  mockMessageList.props = null;
  mockUpload.config = { enabled: false, localUploadEnabled: false };
  mockPersistence.on = false;
  fetchChat.mockReset();
  sendAppChatMessage.mockClear();
  sessionStorage.clear();
});

afterAll(() => {
  window.history.replaceState({}, '', '/');
});

describe('AppChat under a base path', () => {
  test('a message handed over from the start page is sent and the chat stays on its route', async () => {
    renderUnderBasePath('/apps/acme?prefill=Hello%20there&send=true');

    // The auto-send submits the composer, which queues the request and opens
    // the stream.
    await waitFor(() => expect(mockStream.opened).toBeGreaterThan(0));

    // The parameters are gone and the router is still on the app — not on
    // `/ihub/apps/acme` inside the `/ihub` basename (`/ihub/ihub/apps/acme`).
    expect(screen.getByTestId('router-location')).toHaveTextContent(/^\/apps\/acme$/);
    expect(screen.queryByTestId('no-route')).toBeNull();
    expect(screen.getAllByTestId('composer').length).toBeGreaterThan(0);
  });

  test('settings carried in the link are applied and removed without leaving the route', async () => {
    renderUnderBasePath('/apps/acme?model=model-x&keep=1');

    await waitFor(() =>
      expect(screen.getByTestId('router-location')).toHaveTextContent(/^\/apps\/acme\?keep=1$/)
    );
    expect(screen.queryByTestId('no-route')).toBeNull();
  });
});

describe('query-only navigations in the client', () => {
  // `window.location.pathname` includes the base path; a router `navigate()`
  // adds the basename to it a second time.
  test('never navigate to window.location.pathname', () => {
    const root = path.resolve(__dirname, '../../../client/src');
    const offenders = [];
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(full);
        } else if (/\.(jsx?|tsx?)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
          const source = fs.readFileSync(full, 'utf8');
          if (/navigate\(\s*`?\$?\{?\s*window\.location\.pathname/.test(source)) {
            offenders.push(path.relative(root, full));
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
