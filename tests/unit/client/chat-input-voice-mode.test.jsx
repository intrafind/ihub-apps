/**
 * The voice mode button (issue #2868) sits right next to the Send button of the
 * chat input, shows only when voice mode is available, and cannot be started
 * while a turn is streaming.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import ChatInput from '../../../client/src/features/chat/components/ChatInput';

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
jest.mock('../../../client/src/features/chat/components/ChatInputActionsMenu', () => () => (
  <button type="button">+</button>
));
jest.mock('../../../client/src/features/chat/components/ModelHintBanner', () => () => null);
jest.mock('../../../client/src/features/voice/components', () => ({
  VoiceInputComponent: ({ disabled }) => (
    <button type="button" data-testid="dictation" disabled={disabled}>
      mic
    </button>
  )
}));

const inputElement = props => (
  <ChatInput
    app={{ id: 'a' }}
    value=""
    onChange={() => {}}
    onSubmit={() => {}}
    isProcessing={false}
    showModelSelector={false}
    onVoiceInput={() => {}}
    // A second quick action, so dictation is its own button and not folded
    // into the actions menu.
    uploadConfig={{ localUploadEnabled: true }}
    {...props}
  />
);
const renderInput = props => {
  const view = render(inputElement(props));
  return { ...view, update: next => view.rerender(inputElement({ ...props, ...next })) };
};
const composer = () => screen.getByRole('textbox', { name: 'Type your message' });

describe('voice mode button in the chat input', () => {
  test('is not rendered unless voice mode is available', () => {
    renderInput({});
    expect(screen.queryByTestId('voice-mode-button')).not.toBeInTheDocument();
  });

  test('sits directly before the Send button', () => {
    renderInput({ onVoiceMode: () => {} });
    const voice = screen.getByRole('button', { name: 'Start voice mode' });
    const send = screen.getByRole('button', { name: 'Send' });
    expect(voice.nextElementSibling).toBe(send);
  });

  test('starts voice mode on click', () => {
    const onVoiceMode = jest.fn();
    renderInput({ onVoiceMode });
    fireEvent.click(screen.getByRole('button', { name: 'Start voice mode' }));
    expect(onVoiceMode).toHaveBeenCalledTimes(1);
  });

  test('cannot be started while a turn is streaming', () => {
    renderInput({ onVoiceMode: () => {}, isProcessing: true });
    expect(screen.getByRole('button', { name: 'Start voice mode' })).toBeDisabled();
  });

  test('is a pressed toggle that can end voice mode while it is open, and holds dictation back', () => {
    renderInput({ onVoiceMode: () => {}, voiceModeActive: true, isProcessing: true });
    const button = screen.getByRole('button', { name: 'End voice mode' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toBeEnabled();
    expect(screen.getByTestId('dictation')).toBeDisabled();
  });
});

describe('focus after an answer (voice mode owns the keyboard while it is open)', () => {
  test('returns to the input when a typed turn finishes', () => {
    const { update } = renderInput({ onVoiceMode: () => {}, isProcessing: true });
    document.body.focus();
    expect(composer()).not.toHaveFocus();
    update({ isProcessing: false });
    expect(composer()).toHaveFocus();
  });

  test('stays off the covered input when a spoken turn finishes', () => {
    // Before the fix the input took the focus after every answer: the Space of
    // the next push-to-talk turn typed a space into it, a screen reader read
    // "Type your message", and Enter sent a typed turn voice mode knew nothing about.
    const { update } = renderInput({
      onVoiceMode: () => {},
      voiceModeActive: true,
      isProcessing: true
    });
    document.body.focus();
    update({ isProcessing: false });
    expect(composer()).not.toHaveFocus();
    update({ isProcessing: true });
    update({ isProcessing: false });
    expect(composer()).not.toHaveFocus();
  });

  test('does not take the focus on mount while voice mode is open', () => {
    renderInput({ onVoiceMode: () => {}, voiceModeActive: true });
    expect(composer()).not.toHaveFocus();
  });

  test('ending voice mode leaves the focus on the button it goes back to', () => {
    const { update } = renderInput({ onVoiceMode: () => {}, voiceModeActive: true });
    // What the voice view does when it closes: focus back to the opener.
    const opener = screen.getByRole('button', { name: 'End voice mode' });
    opener.focus();
    update({ voiceModeActive: false });
    expect(opener).toHaveFocus();
    expect(composer()).not.toHaveFocus();
  });

  test('a turn that was still streaming when voice mode ended refocuses the input after it', () => {
    const { update } = renderInput({
      onVoiceMode: () => {},
      voiceModeActive: true,
      isProcessing: true
    });
    update({ voiceModeActive: false, isProcessing: true });
    document.body.focus();
    update({ voiceModeActive: false, isProcessing: false });
    expect(composer()).toHaveFocus();
  });
});

describe('focus after an answer (a dialog over the page keeps the keyboard)', () => {
  // The usage guide dialog opens over the chat, also while an answer is being
  // written. A focus trap only handles the keys pressed inside the dialog, so a
  // composer that takes the focus when the answer finishes would take the typing
  // and the next Tab (WCAG 2.4.3).
  const openDialogButton = () => {
    const button = document.createElement('button');
    button.textContent = 'Close guide';
    document.body.appendChild(button);
    button.focus();
    return button;
  };

  afterEach(() => {
    document.body.replaceChildren();
  });

  test('stays inside the dialog when an answer finishes while it is open', () => {
    const { update } = renderInput({ isProcessing: true });
    update({ isProcessing: true, autoFocusSuspended: true });
    const inDialog = openDialogButton();
    update({ isProcessing: false, autoFocusSuspended: true });
    expect(inDialog).toHaveFocus();
    expect(composer()).not.toHaveFocus();
  });

  test('closing the dialog does not move the focus either: it goes back to its opener', () => {
    const { update } = renderInput({ isProcessing: false, autoFocusSuspended: true });
    const opener = openDialogButton();
    update({ isProcessing: false, autoFocusSuspended: false });
    expect(opener).toHaveFocus();
    expect(composer()).not.toHaveFocus();
  });

  test('an answer that was still streaming when the dialog closed refocuses the input after it', () => {
    const { update } = renderInput({ isProcessing: true, autoFocusSuspended: true });
    update({ isProcessing: true, autoFocusSuspended: false });
    document.body.focus();
    update({ isProcessing: false, autoFocusSuspended: false });
    expect(composer()).toHaveFocus();
  });

  test('does not take the focus on mount while a dialog is open', () => {
    renderInput({ autoFocusSuspended: true });
    expect(composer()).not.toHaveFocus();
  });
});

describe('the bottom bar on a 320 px phone', () => {
  // jsdom has no layout, so these pin the classes that make the row shrink the
  // model selector (it has a min-content width) instead of pushing Send out of
  // the card. Measured once in Chromium with a long model name: without them
  // Send ends 58 px outside the card at 320 px; with them it stays inside.
  const models = [
    { id: 'm1', name: { en: 'A model with a really quite long name' } },
    { id: 'm2', name: { en: 'Another one' } }
  ];

  test('the voice mode and Send buttons never shrink', () => {
    renderInput({ onVoiceMode: () => {} });
    expect(screen.getByRole('button', { name: 'Start voice mode' }).className).toMatch(
      /\bshrink-0\b/
    );
    expect(screen.getByRole('button', { name: 'Send' }).className).toMatch(/\bshrink-0\b/);
  });

  test('the model selector shrinks and truncates its label', () => {
    renderInput({
      onVoiceMode: () => {},
      showModelSelector: true,
      models,
      selectedModel: 'm1',
      onModelChange: () => {},
      currentLanguage: 'en'
    });
    const trigger = screen.getByRole('button', { name: /A model with a really quite long name/ });
    expect(trigger.parentElement.className).toMatch(/\bmin-w-0\b/);
    expect(trigger.className).toMatch(/\bmax-w-full\b/);
    const label = screen.getByText('A model with a really quite long name');
    expect(label.className).toMatch(/\bmin-w-0\b/);
    expect(label.className).toMatch(/\btruncate\b/);
  });
});
