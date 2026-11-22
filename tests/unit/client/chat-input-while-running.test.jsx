// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The composer while iHub is working (#3191). With `whileRunning` (given only
 * by the chat page, when the server says the person may send into the running
 * answer) the text field stays open during a run, Stop and Send are two
 * controls in this order, followed by the send menu, and no key stops the run.
 * Without it (the Outlook pane, the canvas, the start page, the extension) the
 * composer keeps its single Send/Stop button.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ChatInput from '../../../client/src/features/chat/components/ChatInput';
import CanvasChatPanel from '../../../client/src/features/canvas/components/CanvasChatPanel';

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
jest.mock('../../../client/src/features/chat/components/ChatMessageList', () => ({
  __esModule: true,
  default: () => null
}));

/** A composer whose text is state, as on the page. */
function Composer({ initial = '', ...props }) {
  const [value, setValue] = require('react').useState(initial);
  return (
    <ChatInput
      app={{ id: 'a' }}
      value={value}
      onChange={e => setValue(e.target.value)}
      onSubmit={() => {}}
      isProcessing={false}
      showModelSelector={false}
      {...props}
    />
  );
}

const textbox = () => screen.getByRole('textbox', { name: 'Type your message' });

function whileRunning(overrides = {}) {
  return {
    enabled: true,
    ready: true,
    blockedReason: null,
    full: false,
    onSteer: jest.fn(),
    onSendAfter: jest.fn(),
    ...overrides
  };
}

describe('the composer while iHub is working', () => {
  test('keeps the text field open and shows Stop, Send and the send menu in this order', () => {
    render(<Composer isProcessing onCancel={jest.fn()} whileRunning={whileRunning()} />);
    expect(textbox()).toBeEnabled();
    expect(textbox()).toHaveAttribute('placeholder', 'Add an instruction for the running answer…');
    const form = textbox().closest('form');
    const names = within(form)
      .getAllByRole('button')
      .map(button => button.getAttribute('aria-label'))
      .filter(name => ['Stop answer', 'Send', 'More ways to send'].includes(name));
    expect(names).toEqual(['Stop answer', 'Send', 'More ways to send']);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  test('Enter with text sends it to the running answer and never stops it', () => {
    const onCancel = jest.fn();
    const running = whileRunning();
    render(
      <Composer
        initial="Use the 2025 numbers"
        isProcessing
        onCancel={onCancel}
        whileRunning={running}
      />
    );
    fireEvent.keyDown(textbox(), { key: 'Enter' });
    expect(running.onSteer).toHaveBeenCalledWith('Use the 2025 numbers');
    expect(onCancel).not.toHaveBeenCalled();
  });

  test('Enter and Ctrl+Enter with an empty field do nothing; a press on Send does not stop', () => {
    const onCancel = jest.fn();
    const running = whileRunning();
    render(<Composer isProcessing onCancel={onCancel} whileRunning={running} />);
    fireEvent.keyDown(textbox(), { key: 'Enter' });
    fireEvent.keyDown(textbox(), { key: 'Enter', ctrlKey: true });
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    fireEvent.click(send);
    // Where the single Stop button used to be: the send menu, closed and off with no text.
    const menuButton = screen.getByRole('button', { name: 'More ways to send' });
    expect(menuButton).toBeDisabled();
    fireEvent.click(menuButton);
    expect(running.onSteer).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  test('Stop answer stops the run', () => {
    const onCancel = jest.fn();
    render(<Composer isProcessing onCancel={onCancel} whileRunning={whileRunning()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop answer' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('Alt+Enter sends after this answer', () => {
    const running = whileRunning();
    render(<Composer initial="Then a summary" isProcessing whileRunning={running} />);
    fireEvent.keyDown(textbox(), { key: 'Enter', altKey: true });
    expect(running.onSendAfter).toHaveBeenCalledWith('Then a summary');
    expect(running.onSteer).not.toHaveBeenCalled();
  });

  test('the send menu works by keyboard and offers "Send after this answer"', () => {
    jest.useFakeTimers();
    try {
      const running = whileRunning();
      render(<Composer initial="Then a summary" isProcessing whileRunning={running} />);
      const menuButton = screen.getByRole('button', { name: 'More ways to send' });
      expect(menuButton).toHaveAttribute('aria-haspopup', 'menu');
      expect(menuButton).toHaveAttribute('aria-expanded', 'false');
      fireEvent.keyDown(menuButton, { key: 'ArrowDown' });
      act(() => jest.runOnlyPendingTimers());
      const item = screen.getByRole('menuitem', { name: /Send after this answer/ });
      expect(menuButton).toHaveAttribute('aria-expanded', 'true');
      expect(item).toHaveFocus();
      fireEvent.keyDown(item, { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
      expect(menuButton).toHaveFocus();

      fireEvent.click(menuButton);
      fireEvent.click(screen.getByRole('menuitem', { name: /Send after this answer/ }));
      expect(running.onSendAfter).toHaveBeenCalledWith('Then a summary');
      expect(screen.queryByRole('menu')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test('with a question above, the field is read-only, stays focusable and says why', () => {
    const running = whileRunning({ blockedReason: 'question' });
    render(<Composer initial="x" isProcessing whileRunning={running} />);
    const field = textbox();
    expect(field).not.toBeDisabled();
    expect(field).toHaveAttribute('readonly');
    expect(field).toHaveAttribute('aria-disabled', 'true');
    expect(field).toHaveAttribute('placeholder', 'Answer the question above first');
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(running.onSteer).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  test('Send waits while the run has not started and while 20 messages wait', () => {
    const { rerender } = render(
      <Composer initial="x" isProcessing whileRunning={whileRunning({ ready: false })} />
    );
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    rerender(<Composer initial="x" isProcessing whileRunning={whileRunning({ full: true })} />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  test('outside a run the composer with whileRunning is the plain one', () => {
    const onSubmit = jest.fn();
    render(<Composer initial="Hello" onSubmit={onSubmit} whileRunning={whileRunning()} />);
    expect(screen.queryByRole('button', { name: 'Stop answer' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test('renders what waits in the chat inside the composer, above the text', () => {
    render(
      <Composer
        isProcessing
        whileRunning={whileRunning()}
        pendingWork={<div data-testid="pending-work">waiting</div>}
      />
    );
    const form = textbox().closest('form');
    const pending = within(form).getByTestId('pending-work');
    expect(
      pending.compareDocumentPosition(textbox()) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});

describe('the composer without whileRunning keeps the single button', () => {
  test('during a run: one Cancel button where Send was, the field closed', () => {
    const onCancel = jest.fn();
    render(<Composer initial="x" isProcessing onCancel={onCancel} />);
    expect(textbox()).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Stop answer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('whileRunning with enabled false is the same', () => {
    render(<Composer isProcessing whileRunning={whileRunning({ enabled: false })} />);
    expect(textbox()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  test('the canvas panel renders today’s single button during a run', () => {
    const onCancel = jest.fn();
    render(
      <CanvasChatPanel
        messages={[]}
        inputValue="Shorter, please"
        onInputChange={() => {}}
        onSubmit={() => {}}
        isProcessing
        onCancel={onCancel}
        app={{ id: 'a' }}
        appId="a"
        chatId="c"
        width={40}
      />
    );
    expect(textbox()).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Stop answer' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
