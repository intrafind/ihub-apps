// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A message while iHub is working (#3191) is the chat page's alone: the Outlook
 * pane (chat panel and start page), the canvas, the chat start page and the
 * browser extension (which runs the Outlook pane's chat) keep today's single
 * Send/Stop button. The composer offers it only to a caller that passes
 * `whileRunning`, so no other caller may pass it, and the Outlook chat panel
 * renders its composer without it while a turn runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom';

const CLIENT_SRC = path.resolve(__dirname, '../../../client/src');

/** Every client source file below `dir`. */
function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.(jsx?|tsx?)$/.test(entry.name) ? [full] : [];
  });
}

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue) => (typeof defaultValue === 'string' ? defaultValue : key),
    i18n: { language: 'en' }
  })
}));
jest.mock('../../../client/src/features/upload/utils/fileProcessing', () => ({
  processDocumentFile: jest.fn(),
  resizeImageCanvas: jest.fn()
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildAssetUrl: p => p,
  buildApiUrl: p => `/api/${p}`,
  getBasePath: () => '',
  KNOWN_ROUTES: []
}));
jest.mock('../../../client/src/api', () => ({
  fetchApps: jest.fn(() => Promise.resolve([]))
}));
jest.mock('../../../client/src/features/office/contexts/OfficeConfigContext', () => ({
  useOfficeConfig: () => ({ starterPrompts: [], calendarStarterPrompts: [] })
}));
jest.mock('../../../client/src/features/office/hooks/useOfficeChatAdapter', () => ({
  __esModule: true,
  default: () => ({
    messages: [
      { id: 'u1', role: 'user', content: 'Summarize' },
      { id: 'a1', role: 'assistant', content: '', loading: true }
    ],
    processing: true,
    clarificationPending: false,
    sendMessage: jest.fn(),
    clearMessages: jest.fn(),
    deleteMessage: jest.fn(),
    editMessage: jest.fn(),
    resendMessage: jest.fn(),
    cancelGeneration: jest.fn()
  })
}));
jest.mock('../../../client/src/shared/hooks/useAppSettings', () => ({
  __esModule: true,
  default: () => ({
    models: [{ id: 'gpt' }],
    selectedModel: 'gpt',
    setSelectedModel: jest.fn(),
    enabledTools: [],
    setEnabledTools: jest.fn(),
    websearchEnabled: false,
    setWebsearchEnabled: jest.fn(),
    hostContextFlags: null,
    setHostContextFlags: jest.fn(),
    modelsLoading: false
  })
}));
jest.mock('../../../client/src/shared/hooks/useFileUploadHandler', () => ({
  __esModule: true,
  default: () => ({
    createUploadConfig: () => ({}),
    selectedFile: null,
    handleFileSelect: jest.fn(),
    showUploader: false,
    toggleUploader: jest.fn(),
    clearSelectedFile: jest.fn(),
    setSelectedFile: jest.fn()
  })
}));
jest.mock('../../../client/src/features/office/hooks/useOutlookMailContextSnapshot', () => ({
  __esModule: true,
  default: () => ({
    loading: false,
    ctx: { available: true, itemId: 'm1', itemKind: 'message', subject: 'Mail', attachments: [] },
    visibleAttachments: [],
    removedAttachmentIds: new Set(),
    removeAttachment: jest.fn(),
    restoreAttachments: jest.fn(),
    buildSnapshotOverride: () => null,
    includeBody: true,
    setIncludeBody: jest.fn(),
    generation: 0
  })
}));
jest.mock('../../../client/src/features/office/hooks/useOutlookMailActions', () => ({
  __esModule: true,
  default: () => ({
    actions: [],
    defaultActionId: null,
    runAction: jest.fn(),
    notice: null,
    dismissNotice: jest.fn()
  })
}));
jest.mock('../../../client/src/features/chat/components/ChatMessageList', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/office/components/chat/OfficeContextStrip', () => ({
  __esModule: true,
  default: () => null
}));
const mockComposerProps = [];
jest.mock('../../../client/src/features/chat/components/ChatInput', () => ({
  __esModule: true,
  default: props => {
    mockComposerProps.push(props);
    return <textarea aria-label="message" readOnly value={props.value || ''} />;
  }
}));

const OfficeChatPanel =
  require('../../../client/src/features/office/components/OfficeChatPanel').default;

describe('who offers a message while iHub is working', () => {
  test('only the chat page passes whileRunning to the composer', () => {
    const callers = sources(CLIENT_SRC).filter(file =>
      /<ChatInput\b/.test(fs.readFileSync(file, 'utf8'))
    );
    const relative = callers.map(file => path.relative(CLIENT_SRC, file).split(path.sep).join('/'));
    // The composer's other callers today: the Outlook pane, the canvas and the start page.
    expect(relative).toEqual(
      expect.arrayContaining([
        'features/apps/pages/AppChat.jsx',
        'features/office/components/OfficeChatPanel.jsx',
        'features/office/components/OfficeStartPage.jsx',
        'features/canvas/components/CanvasChatPanel.jsx',
        'features/chat/components/AppChatStarter.jsx'
      ])
    );
    const offering = callers
      .filter(file => /\bwhileRunning\b/.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(CLIENT_SRC, file).split(path.sep).join('/'));
    expect(offering).toEqual(['features/apps/pages/AppChat.jsx']);
  });

  test('the Outlook chat panel renders its composer without it while a turn runs', () => {
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <OfficeChatPanel
          authData={{ user: { name: 'Ada' } }}
          selectedApp={{
            id: 'chat',
            name: { en: 'Chat' },
            system: { en: 'x' },
            starterPrompts: []
          }}
          setSelectedApp={jest.fn()}
          onLogout={jest.fn()}
          homePath="/start"
        />
      </MemoryRouter>
    );
    const last = mockComposerProps.at(-1);
    expect(last.isProcessing).toBe(true);
    expect(last.whileRunning).toBeUndefined();
    expect(last.pendingWork).toBeUndefined();
  });
});
