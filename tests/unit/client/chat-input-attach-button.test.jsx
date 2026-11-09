// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The paper clip of an app with uploads stays reachable on a desktop, whatever
 * else the composer offers. The input bar and the "+" menu each decide whether
 * upload is the only action (then the menu renders the paper clip itself and
 * the bar does not); when the two disagreed, neither showed it. In 5.6.4 an app
 * with web search hid its upload until magic prompt was turned on; the same
 * held for the browser extension's "Include page" toggle.
 *
 * jsdom applies no CSS, so "shown on a desktop" is read from the Tailwind
 * classes: not under `md:hidden`, and not `hidden` unless an `md:` display
 * class brings it back.
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import ChatInput from '../../../client/src/features/chat/components/ChatInput';
import { EmbeddedHostProvider } from '../../../client/src/features/office/contexts/EmbeddedHostContext';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key, defaultOrOptions) => (typeof defaultOrOptions === 'string' ? defaultOrOptions : key)
  })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));
jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  useUIConfig: () => ({ uiConfig: {} })
}));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: {} })
}));
jest.mock('../../../client/src/shared/hooks/useFeatureFlags', () => ({
  __esModule: true,
  default: () => ({ isEnabled: () => false, isBothEnabled: () => false })
}));
jest.mock('../../../client/src/shared/hooks/useEstimatedTokenCount.js', () => ({
  useEstimatedTokenCount: () => 0,
  useEstimatedTokensForFragments: () => 0
}));
jest.mock('../../../client/src/features/upload/components', () => ({
  UnifiedUploader: ({ children }) => children,
  CloudStoragePicker: () => null,
  AttachedFilesList: () => null
}));
jest.mock('../../../client/src/features/prompts/components/PromptSearch', () => () => null);
jest.mock('../../../client/src/features/prompts/hooks/usePromptLauncher', () => () => ({
  launch: async () => null,
  dialog: null
}));
jest.mock('../../../client/src/features/chat/components/WorkflowMentionSearch', () => () => null);
jest.mock('../../../client/src/features/projects/components/ChatProjectChips', () => () => null);
jest.mock('../../../client/src/features/projects/components/ChatProjectPicker', () => ({
  __esModule: true,
  default: () => null,
  useOfferedProjects: () => []
}));
jest.mock('../../../client/src/features/chat/components/ModelHintBanner', () => () => null);
// The "+" menu saves the integration defaults through the API; nothing is saved here.
jest.mock('../../../client/src/api', () => ({
  saveIntegrationPreferences: jest.fn(() => Promise.resolve({}))
}));
jest.mock('../../../client/src/features/voice/components', () => ({
  VoiceInputComponent: () => null
}));

const UPLOAD = { enabled: true, localUploadEnabled: true };

const renderInput = props =>
  render(
    <ChatInput
      app={{ id: 'files' }}
      value=""
      onChange={() => {}}
      onSubmit={() => {}}
      isProcessing={false}
      showModelSelector={false}
      uploadConfig={UPLOAD}
      {...props}
    />
  );

/** Whether the Tailwind classes on the element and its ancestors show it at `md:` and up. */
const shownOnDesktop = element => {
  for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
    const classes = (node.getAttribute('class') || '').split(/\s+/);
    if (classes.includes('md:hidden')) return false;
    const brought = classes.some(c => /^md:(block|flex|inline|inline-flex|grid)$/.test(c));
    if (classes.includes('hidden') && !brought) return false;
  }
  return true;
};

const desktopAttachButtons = () =>
  screen.queryAllByTitle('Attach File').filter(button => shownOnDesktop(button));

describe('the paper clip on a desktop', () => {
  test('upload as the only action: one paper clip, no menu', () => {
    renderInput();
    expect(desktopAttachButtons()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Actions menu' })).toBeNull();
  });

  test('with web search on the app it stays beside the "+" menu', () => {
    renderInput({
      app: { id: 'files', websearch: { enabled: true } },
      websearchEnabled: false,
      onWebsearchEnabledChange: () => {}
    });
    expect(desktopAttachButtons()).toHaveLength(1);
  });

  test('with magic prompt on as well, still exactly one', () => {
    renderInput({
      app: { id: 'files', websearch: { enabled: true } },
      onWebsearchEnabledChange: () => {},
      magicPromptEnabled: true,
      onMagicPrompt: () => {}
    });
    expect(desktopAttachButtons()).toHaveLength(1);
  });

  test('in a host with context toggles (browser extension) it stays beside the "+" menu', () => {
    const host = {
      kind: 'extension',
      contextToggles: [{ key: 'pageText', label: 'Include page', defaultEnabled: true }]
    };
    render(
      <EmbeddedHostProvider value={host}>
        <ChatInput
          app={{ id: 'files' }}
          value=""
          onChange={() => {}}
          onSubmit={() => {}}
          isProcessing={false}
          showModelSelector={false}
          uploadConfig={UPLOAD}
          hostContextFlags={{}}
          onHostContextFlagChange={() => {}}
        />
      </EmbeddedHostProvider>
    );
    expect(screen.getByRole('button', { name: 'Actions menu' })).toBeInTheDocument();
    expect(desktopAttachButtons()).toHaveLength(1);
  });
});
