// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Issue #3524: the Outlook task pane's composer can be expanded to about half
 * the pane for a long prompt. It is the same text area with other limits; it
 * collapses on send, on Escape, on a second click and when a chat starts or a
 * new one does. Other hosts do not offer the button.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useState } from 'react';
import ChatInput from '../../../client/src/features/chat/components/ChatInput';
import {
  composerLineLimits,
  EXPANDED_LINES
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
jest.mock(
  '../../../client/src/features/prompts/components/PromptSearch',
  () => props => (props.isOpen ? <div data-testid="picker" /> : null)
);
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
jest.mock('../../../client/src/features/chat/components/ChatInputActionsMenu', () => () => null);
jest.mock('../../../client/src/features/chat/components/ModelHintBanner', () => () => null);
jest.mock('../../../client/src/features/voice/components', () => ({
  VoiceInputComponent: () => null
}));

const multilineApp = { id: 'writer', inputMode: { type: 'multiline', rows: 5 } };

function Harness({ initial = 'A long prompt', onSubmit = () => {}, ...props }) {
  const [value, setValue] = useState(initial);
  return (
    <ChatInput
      app={multilineApp}
      value={value}
      onChange={event => setValue(event.target.value)}
      onSubmit={e => {
        onSubmit(e);
        setValue('');
      }}
      isProcessing={false}
      showModelSelector={false}
      maxRows={3}
      expandable
      {...props}
    />
  );
}

const textbox = () => screen.getByRole('textbox', { name: 'Type your message' });
const expandButton = () => screen.getByRole('button', { name: /^(Expand|Collapse) input$/ });
const lines = textarea => ({
  min: textarea.style.getPropertyValue('--composer-min-lines'),
  max: textarea.style.getPropertyValue('--composer-max-lines')
});

describe('composerLineLimits when expanded', () => {
  test('the expanded composer has the expanded lines, whatever the cap and rows', () => {
    const expanded = { minLines: EXPANDED_LINES, maxLines: EXPANDED_LINES };
    expect(composerLineLimits({ multiline: true, rows: 5, maxRows: 3, expanded: true })).toEqual(
      expanded
    );
    expect(
      composerLineLimits({ multiline: true, rows: 5, maxRows: 3, compact: true, expanded: true })
    ).toEqual(expanded);
    expect(composerLineLimits({ multiline: false, expanded: true })).toEqual(expanded);
  });

  test('collapsed, the cap holds as before', () => {
    expect(composerLineLimits({ multiline: true, rows: 5, maxRows: 3, compact: true })).toEqual({
      minLines: 1,
      maxLines: 3
    });
  });
});

describe('ChatInput expand button', () => {
  test('is not offered unless the host opts in', () => {
    render(<Harness expandable={false} />);
    expect(screen.queryByRole('button', { name: 'Expand input' })).not.toBeInTheDocument();
    expect(textbox()).not.toHaveClass('chat-input-textarea--expanded');
  });

  test('toggles the same text area between the cap and the expanded size', () => {
    render(<Harness compact />);
    const textarea = textbox();
    expect(expandButton()).toHaveAttribute('aria-expanded', 'false');
    expect(expandButton()).toHaveAccessibleName('Expand input');
    expect(lines(textarea)).toEqual({ min: '1', max: '3' });

    fireEvent.click(expandButton());
    expect(textbox()).toBe(textarea);
    expect(expandButton()).toHaveAttribute('aria-expanded', 'true');
    expect(expandButton()).toHaveAccessibleName('Collapse input');
    expect(textarea).toHaveClass('chat-input-textarea--expanded');
    expect(lines(textarea)).toEqual({ min: String(EXPANDED_LINES), max: String(EXPANDED_LINES) });

    fireEvent.click(expandButton());
    expect(expandButton()).toHaveAttribute('aria-expanded', 'false');
    expect(textarea).not.toHaveClass('chat-input-textarea--expanded');
    expect(lines(textarea)).toEqual({ min: '1', max: '3' });
  });

  test('keeps the focus, the text and the caret in the text area', () => {
    render(<Harness initial="Hello world" />);
    const textarea = textbox();
    textarea.focus();
    textarea.setSelectionRange(5, 5);

    // A mouse press on the button does not take the focus.
    const pressed = fireEvent.mouseDown(expandButton());
    expect(pressed).toBe(false);
    fireEvent.click(expandButton());

    expect(textarea).toHaveFocus();
    expect(textarea).toHaveValue('Hello world');
    expect(textarea.selectionStart).toBe(5);
    expect(textarea.selectionEnd).toBe(5);
  });

  test('collapses on Escape in the text area and on the button', () => {
    render(<Harness />);
    fireEvent.click(expandButton());
    fireEvent.keyDown(textbox(), { key: 'Escape' });
    expect(expandButton()).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(expandButton());
    fireEvent.keyDown(expandButton(), { key: 'Escape' });
    expect(expandButton()).toHaveAttribute('aria-expanded', 'false');
  });

  test('Escape closes the prompt picker first and leaves the composer expanded', () => {
    render(<Harness initial="" />);
    fireEvent.click(expandButton());
    fireEvent.keyDown(textbox(), { key: '/' });
    expect(screen.getByTestId('picker')).toBeInTheDocument();

    fireEvent.keyDown(textbox(), { key: 'Escape' });
    expect(screen.queryByTestId('picker')).not.toBeInTheDocument();
    expect(expandButton()).toHaveAttribute('aria-expanded', 'true');
  });

  test('collapses on send', () => {
    jest.useFakeTimers();
    try {
      const onSubmit = jest.fn();
      render(<Harness onSubmit={onSubmit} />);
      fireEvent.click(expandButton());
      fireEvent.keyDown(textbox(), { key: 'Enter', ctrlKey: true });
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(expandButton()).toHaveAttribute('aria-expanded', 'false');
      act(() => jest.runAllTimers());
    } finally {
      jest.useRealTimers();
    }
  });

  test('a new chat starts collapsed', () => {
    const { rerender } = render(<Harness compact />);
    fireEvent.click(expandButton());
    expect(expandButton()).toHaveAttribute('aria-expanded', 'true');

    // The Outlook panel's "new chat" clears the conversation: not compact any more.
    rerender(<Harness compact={false} />);
    expect(expandButton()).toHaveAttribute('aria-expanded', 'false');
  });

  test('sits next to the clear button without covering it', () => {
    render(<Harness />);
    expect(expandButton()).toHaveClass('right-3');
    expect(screen.getByRole('button', { name: 'Clear input' })).toHaveClass('right-9');
    expect(textbox()).toHaveClass('pr-16');
  });

  test("sits on the one-line composer's line, and on the first line when expanded", () => {
    // The one-line composer's text row is taller (as tall as the toolbar), so
    // its icons move down with the line; ChatInput.css holds the padding.
    const clearButton = () => screen.getByRole('button', { name: 'Clear input' });
    const { rerender } = render(<Harness />);
    expect(expandButton()).toHaveClass('top-3');
    expect(clearButton()).toHaveClass('top-3');

    rerender(<Harness compact />);
    expect(expandButton()).toHaveClass('top-4', 'sm:top-5');
    expect(clearButton()).toHaveClass('top-4', 'sm:top-5');

    fireEvent.click(expandButton());
    expect(expandButton()).toHaveClass('top-3');
    expect(expandButton()).not.toHaveClass('top-4');
    expect(clearButton()).toHaveClass('top-3');
  });
});
