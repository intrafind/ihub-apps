// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Issue #3520: an app's `inputMode.rows` are for the empty chat. Once the
 * conversation has started the composer is one line that grows as the user
 * types, a host cap (the Outlook task pane's 3) wins over the app's rows, and
 * the multi-line send shortcut is announced and shown while writing.
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import ChatInput from '../../../client/src/features/chat/components/ChatInput';
import {
  composerLineLimits,
  DEFAULT_MAX_LINES
} from '../../../client/src/features/chat/utils/composerLines';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key, defaultOrOptions, options) =>
      typeof defaultOrOptions === 'string'
        ? defaultOrOptions.replace(/{{(\w+)}}/g, (_, name) => options?.[name] ?? '')
        : (defaultOrOptions?.defaultValue ?? key)
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
jest.mock('../../../client/src/features/chat/components/ChatInputActionsMenu', () => () => (
  <button type="button">+</button>
));
jest.mock('../../../client/src/features/chat/components/ModelHintBanner', () => () => null);
jest.mock('../../../client/src/features/voice/components', () => ({
  VoiceInputComponent: () => null
}));

const multilineApp = { id: 'writer', inputMode: { type: 'multiline', rows: 5 } };
const singlelineApp = { id: 'search', inputMode: { type: 'singleline', rows: 5 } };

const renderInput = props =>
  render(
    <ChatInput
      app={multilineApp}
      value=""
      onChange={() => {}}
      onSubmit={() => {}}
      isProcessing={false}
      showModelSelector={false}
      {...props}
    />
  );

const lines = textarea => ({
  min: textarea.style.getPropertyValue('--composer-min-lines'),
  max: textarea.style.getPropertyValue('--composer-max-lines')
});

describe('composerLineLimits', () => {
  test('a multi-line app shows its rows in an empty chat', () => {
    expect(composerLineLimits({ multiline: true, rows: 5 })).toEqual({
      minLines: 5,
      maxLines: DEFAULT_MAX_LINES.multiline
    });
  });

  test('once the chat has started, it starts at one line', () => {
    expect(composerLineLimits({ multiline: true, rows: 5, compact: true })).toEqual({
      minLines: 1,
      maxLines: DEFAULT_MAX_LINES.multiline
    });
  });

  test("the host's cap wins over the app's rows", () => {
    expect(composerLineLimits({ multiline: true, rows: 5, maxRows: 3 })).toEqual({
      minLines: 3,
      maxLines: 3
    });
    expect(composerLineLimits({ multiline: true, rows: 5, maxRows: 3, compact: true })).toEqual({
      minLines: 1,
      maxLines: 3
    });
  });

  test('an app may ask for more rows than the composer grows to', () => {
    // The schema and the admin field allow up to 20.
    expect(composerLineLimits({ multiline: true, rows: 16 })).toEqual({
      minLines: 16,
      maxLines: 16
    });
    expect(composerLineLimits({ multiline: true, rows: 16, compact: true })).toEqual({
      minLines: 1,
      maxLines: DEFAULT_MAX_LINES.multiline
    });
    expect(composerLineLimits({ multiline: true, rows: 16, maxRows: 3 })).toEqual({
      minLines: 3,
      maxLines: 3
    });
  });

  test('a single-line app is one line, whatever its rows', () => {
    expect(composerLineLimits({ multiline: false, rows: 8 })).toEqual({
      minLines: 1,
      maxLines: DEFAULT_MAX_LINES.singleline
    });
  });

  test('rows that are missing or not a number fall back to two', () => {
    expect(composerLineLimits({ multiline: true }).minLines).toBe(2);
    expect(composerLineLimits({ multiline: true, rows: 'many' }).minLines).toBe(2);
    expect(composerLineLimits({ multiline: true, rows: 0 }).minLines).toBe(2);
  });
});

describe('ChatInput size', () => {
  test('an empty chat has the configured rows; the box itself is one row', () => {
    renderInput();
    const textarea = screen.getByRole('textbox', { name: 'Type your message' });
    expect(textarea).toHaveAttribute('rows', '1');
    expect(lines(textarea)).toEqual({ min: '5', max: '12' });
    expect(textarea).not.toHaveClass('chat-input-textarea--compact');
  });

  test('a started chat has a one-line composer that keeps its placeholder on one line', () => {
    renderInput({ compact: true });
    const textarea = screen.getByRole('textbox', { name: 'Type your message' });
    expect(lines(textarea)).toEqual({ min: '1', max: '12' });
    expect(textarea).toHaveClass('chat-input-textarea--compact');
  });

  test('the Outlook cap holds for an app with more rows', () => {
    const { rerender } = renderInput({ maxRows: 3 });
    const textarea = screen.getByRole('textbox', { name: 'Type your message' });
    expect(lines(textarea)).toEqual({ min: '3', max: '3' });

    rerender(
      <ChatInput
        app={multilineApp}
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        isProcessing={false}
        showModelSelector={false}
        maxRows={3}
        compact
      />
    );
    expect(lines(textarea)).toEqual({ min: '1', max: '3' });
  });

  test('a single-line app is one line', () => {
    renderInput({ app: singlelineApp });
    const textarea = screen.getByRole('textbox', { name: 'Type your message' });
    expect(lines(textarea)).toEqual({ min: '1', max: '5' });
  });
});

describe('ChatInput send hint', () => {
  test('a multi-line input describes its send shortcut to screen readers', () => {
    renderInput();
    expect(screen.getByRole('textbox', { name: 'Type your message' })).toHaveAccessibleDescription(
      'Ctrl + Enter to send'
    );
    // Nothing typed: only the description, nothing on screen.
    expect(screen.getAllByText('Ctrl + Enter to send')).toHaveLength(1);
  });

  test('the shortcut shows on screen while a multi-line message is written', () => {
    renderInput({ value: 'Draft a reply' });
    expect(screen.getAllByText('Ctrl + Enter to send')).toHaveLength(2);
  });

  test('not while the answer is being produced', () => {
    renderInput({ value: 'Draft a reply', isProcessing: true });
    expect(screen.getAllByText('Ctrl + Enter to send')).toHaveLength(1);
  });

  test('a single-line input sends with Enter and shows no hint', () => {
    renderInput({ app: singlelineApp, value: 'search terms' });
    expect(screen.getByRole('textbox', { name: 'Type your message' })).toHaveAccessibleDescription(
      'Enter to send'
    );
    expect(screen.getAllByText('Enter to send')).toHaveLength(1);
  });
});
