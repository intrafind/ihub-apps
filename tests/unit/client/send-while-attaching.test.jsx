/**
 * Sending while an attachment is still being processed (issue #2835).
 *
 * Extracting the audio of a video takes a while. A message sent meanwhile used
 * to go without it, and the attachment then joined the next message instead.
 * The uploader says when it is busy (`onProcessingChange`), and the chat input
 * and the start form hold back sending until the attachment is there.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';

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

// The uploader, reduced to the one thing under test: the `onProcessingChange`
// it was given, which the test calls the way the real uploader does.
let setUploaderBusy;
const FakeUploader = ({ children, onProcessingChange }) => {
  setUploaderBusy = busy => act(() => onProcessingChange(busy));
  return children;
};
jest.mock('../../../client/src/features/upload/components', () => ({
  UnifiedUploader: props => FakeUploader(props),
  CloudStoragePicker: () => null,
  AttachedFilesList: () => null
}));
jest.mock('../../../client/src/features/upload/components/UnifiedUploader', () => ({
  __esModule: true,
  default: props => FakeUploader(props)
}));
jest.mock('../../../client/src/features/upload/components/AttachedFilesList', () => ({
  __esModule: true,
  default: () => null
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
  VoiceInputComponent: () => null
}));

const ChatInput = require('../../../client/src/features/chat/components/ChatInput').default;
const ChatStartForm = require('../../../client/src/features/chat/components/ChatStartForm').default;

describe('ChatInput', () => {
  const renderInput = props => {
    const onSubmit = jest.fn();
    render(
      <ChatInput
        app={{ id: 'stt' }}
        value="please transcribe"
        onChange={() => {}}
        onSubmit={onSubmit}
        isProcessing={false}
        showModelSelector={false}
        uploadConfig={{ localUploadEnabled: true }}
        {...props}
      />
    );
    return { onSubmit };
  };
  const sendButton = () => screen.getByRole('button', { name: 'Send' });
  const typeInto = () => screen.getByRole('textbox', { name: 'Type your message' });

  test('sends as usual while no attachment is being processed', () => {
    const { onSubmit } = renderInput();

    expect(sendButton()).toBeEnabled();
    fireEvent.click(sendButton());

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test('holds back the send button until the attachment is there', () => {
    const { onSubmit } = renderInput();

    setUploaderBusy(true);
    expect(sendButton()).toBeDisabled();
    fireEvent.click(sendButton());
    expect(onSubmit).not.toHaveBeenCalled();

    setUploaderBusy(false);
    expect(sendButton()).toBeEnabled();
    fireEvent.click(sendButton());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test('holds back Enter, too', () => {
    const { onSubmit } = renderInput({ multilineMode: false });

    setUploaderBusy(true);
    fireEvent.keyDown(typeInto(), { key: 'Enter' });
    fireEvent.keyDown(typeInto(), { key: 'Enter', ctrlKey: true });
    expect(onSubmit).not.toHaveBeenCalled();

    setUploaderBusy(false);
    fireEvent.keyDown(typeInto(), { key: 'Enter', ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test('holds back submitting the form', () => {
    const { onSubmit } = renderInput();

    setUploaderBusy(true);
    fireEvent.submit(typeInto().closest('form'));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('leaves the Cancel button of a running chat alone', () => {
    const onCancel = jest.fn();
    renderInput({ isProcessing: true, onCancel });

    setUploaderBusy(true);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toBeEnabled();
    fireEvent.click(cancel);

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('ChatStartForm', () => {
  const renderForm = () => {
    const onSubmit = jest.fn();
    render(
      <ChatStartForm
        app={{ id: 'translator', variables: [], startForm: { enabled: true } }}
        localizedVariables={[]}
        variables={{}}
        onVariablesChange={() => {}}
        uploadConfig={{ localUploadEnabled: true }}
        selectedFile={null}
        onFileSelect={() => {}}
        onSubmit={onSubmit}
        currentLanguage="en"
      />
    );
    return { onSubmit };
  };

  test('starts the chat as usual while no attachment is being processed', () => {
    const { onSubmit } = renderForm();

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test('holds back the start button until the attachment is there', () => {
    const { onSubmit } = renderForm();

    setUploaderBusy(true);
    const start = screen.getByRole('button', { name: 'Start' });
    expect(start).toBeDisabled();
    fireEvent.submit(start.closest('form'));
    expect(onSubmit).not.toHaveBeenCalled();

    setUploaderBusy(false);
    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
