/**
 * Sending while an attachment is still being processed (issue #2835).
 *
 * Extracting the audio of a video takes a while. A message sent meanwhile used
 * to go without it, and the attachment then joined the next message instead.
 * The uploader says when it is busy (`onProcessingChange`), and the chat input
 * and the start form hold back sending until the attachment is there.
 *
 * A page may mount several composers for one chat and show one of them by CSS
 * (AppChat: a phone and a desktop layout). They share what is being processed
 * through `useFileUploadHandler`, so the one that comes into view after a resize
 * holds back, too.
 */
import '@testing-library/jest-dom';
import { useRef } from 'react';
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';

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
// `setUploaderBusy` belongs to the uploader rendered last; `uploaders` holds every
// one on screen, in the order they first rendered.
let setUploaderBusy;
let uploaders = [];
const FakeUploader = ({ children, onProcessingChange }) => {
  const self = useRef(null);
  if (!self.current) {
    self.current = {};
    uploaders.push(self.current);
  }
  self.current.setBusy = busy => act(() => onProcessingChange(busy));
  setUploaderBusy = self.current.setBusy;
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
const useFileUploadHandler =
  require('../../../client/src/shared/hooks/useFileUploadHandler').default;
const useAttachmentProcessing =
  require('../../../client/src/shared/hooks/useAttachmentProcessing').default;

beforeEach(() => {
  uploaders = [];
});

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
  const renderForm = props => {
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
        {...props}
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

  test('holds back the start button while the page says an attachment is being processed', () => {
    const { onSubmit } = renderForm({ isAttachmentProcessing: true });

    const start = screen.getByRole('button', { name: 'Start' });
    expect(start).toBeDisabled();
    fireEvent.submit(start.closest('form'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('tells the page when its uploader is busy and when it is done', () => {
    const onAttachmentProcessingChange = jest.fn();
    renderForm({ onAttachmentProcessingChange });

    setUploaderBusy(true);
    setUploaderBusy(false);

    const reports = onAttachmentProcessingChange.mock.calls;
    expect(reports.map(([, busy]) => busy)).toEqual([true, false]);
    expect(typeof reports[0][0]).toBe('string');
    expect(reports[1][0]).toBe(reports[0][0]);
  });
});

describe('composers that share an upload handler', () => {
  const composerProps = {
    app: { id: 'stt' },
    value: 'please transcribe',
    onChange: () => {},
    isProcessing: false,
    showModelSelector: false,
    multilineMode: false,
    uploadConfig: { localUploadEnabled: true }
  };

  // Two composers of one chat, as AppChat mounts them: one for the phone layout,
  // one for the desktop layout. Both are in the page, CSS shows either.
  function Composers({ onSubmitFirst, onSubmitSecond, showFirst = true, share = true }) {
    const handler = useFileUploadHandler();
    const shared = share
      ? {
          isAttachmentProcessing: handler.isAttachmentProcessing,
          onAttachmentProcessingChange: handler.setAttachmentProcessing
        }
      : {};
    return (
      <>
        {showFirst && (
          <div data-testid="first">
            <ChatInput {...composerProps} {...shared} onSubmit={onSubmitFirst} />
          </div>
        )}
        <div data-testid="second">
          <ChatInput {...composerProps} {...shared} onSubmit={onSubmitSecond} />
        </div>
      </>
    );
  }

  const renderComposers = props => {
    const onSubmitFirst = jest.fn();
    const onSubmitSecond = jest.fn();
    const utils = render(
      <Composers onSubmitFirst={onSubmitFirst} onSubmitSecond={onSubmitSecond} {...props} />
    );
    const composer = testId => within(screen.getByTestId(testId));
    return {
      ...utils,
      onSubmitFirst,
      onSubmitSecond,
      sendButton: testId => composer(testId).getByRole('button', { name: 'Send' }),
      textbox: testId => composer(testId).getByRole('textbox', { name: 'Type your message' }),
      rerenderWith: next =>
        utils.rerender(
          <Composers
            onSubmitFirst={onSubmitFirst}
            onSubmitSecond={onSubmitSecond}
            {...props}
            {...next}
          />
        )
    };
  };

  test('the other composer holds back sending while one uploader is busy', () => {
    const { sendButton, textbox, onSubmitFirst, onSubmitSecond } = renderComposers();
    expect(sendButton('second')).toBeEnabled();

    // The file is on its way in the first composer; the second one comes into view
    uploaders[0].setBusy(true);

    expect(sendButton('first')).toBeDisabled();
    expect(sendButton('second')).toBeDisabled();
    fireEvent.click(sendButton('second'));
    fireEvent.keyDown(textbox('second'), { key: 'Enter', ctrlKey: true });
    fireEvent.submit(textbox('second').closest('form'));
    expect(onSubmitSecond).not.toHaveBeenCalled();
    expect(onSubmitFirst).not.toHaveBeenCalled();

    uploaders[0].setBusy(false);
    expect(sendButton('second')).toBeEnabled();
    fireEvent.click(sendButton('second'));
    expect(onSubmitSecond).toHaveBeenCalledTimes(1);
  });

  test('it works the other way round, too', () => {
    const { sendButton, onSubmitFirst } = renderComposers();

    uploaders[1].setBusy(true);

    expect(sendButton('first')).toBeDisabled();
    fireEvent.click(sendButton('first'));
    expect(onSubmitFirst).not.toHaveBeenCalled();
  });

  test('holds back until every busy uploader is done', () => {
    const { sendButton } = renderComposers();

    uploaders[0].setBusy(true);
    uploaders[1].setBusy(true);
    uploaders[0].setBusy(false);
    expect(sendButton('second')).toBeDisabled();
    expect(sendButton('first')).toBeDisabled();

    uploaders[1].setBusy(false);
    expect(sendButton('second')).toBeEnabled();
    expect(sendButton('first')).toBeEnabled();
  });

  test('a composer that goes away does not leave the other one waiting', () => {
    const { sendButton, rerenderWith } = renderComposers();
    uploaders[0].setBusy(true);
    expect(sendButton('second')).toBeDisabled();

    rerenderWith({ showFirst: false });

    expect(sendButton('second')).toBeEnabled();
  });

  test('composers that do not share keep to their own uploader', () => {
    const { sendButton } = renderComposers({ share: false });

    uploaders[0].setBusy(true);

    expect(sendButton('first')).toBeDisabled();
    expect(sendButton('second')).toBeEnabled();
  });
});

describe('useFileUploadHandler', () => {
  test('has no attachment processing to begin with', () => {
    const { result } = renderHook(() => useFileUploadHandler());

    expect(result.current.isAttachmentProcessing).toBe(false);
  });

  test('says so while any uploader reports itself busy, and only then', () => {
    const { result } = renderHook(() => useFileUploadHandler());

    act(() => result.current.setAttachmentProcessing('phone', true));
    expect(result.current.isAttachmentProcessing).toBe(true);
    act(() => result.current.setAttachmentProcessing('desktop', true));
    act(() => result.current.setAttachmentProcessing('phone', false));
    expect(result.current.isAttachmentProcessing).toBe(true);

    act(() => result.current.setAttachmentProcessing('desktop', false));
    expect(result.current.isAttachmentProcessing).toBe(false);
  });

  test('counts an uploader once, however often it reports', () => {
    const { result } = renderHook(() => useFileUploadHandler());

    act(() => result.current.setAttachmentProcessing('phone', true));
    act(() => result.current.setAttachmentProcessing('phone', true));
    act(() => result.current.setAttachmentProcessing('phone', false));
    // A report of "idle" for an uploader that never was busy changes nothing
    act(() => result.current.setAttachmentProcessing('desktop', false));

    expect(result.current.isAttachmentProcessing).toBe(false);
  });

  test('keeps the report function across renders, so an uploader is not restarted', () => {
    const { result, rerender } = renderHook(() => useFileUploadHandler());
    const first = result.current.setAttachmentProcessing;

    act(() => result.current.setAttachmentProcessing('phone', true));
    rerender();

    expect(result.current.setAttachmentProcessing).toBe(first);
  });
});

describe('useAttachmentProcessing', () => {
  test('is busy while its own uploader is, with nothing shared', () => {
    const { result } = renderHook(() => useAttachmentProcessing());
    expect(result.current.attachmentProcessing).toBe(false);

    act(() => result.current.onProcessingChange(true));
    expect(result.current.attachmentProcessing).toBe(true);

    act(() => result.current.onProcessingChange(false));
    expect(result.current.attachmentProcessing).toBe(false);
  });

  test('is busy while the page says an attachment is processed', () => {
    const { result } = renderHook(() => useAttachmentProcessing(true));

    expect(result.current.attachmentProcessing).toBe(true);
  });

  test('a new report function neither restarts the uploader nor is missed', () => {
    const first = jest.fn();
    const second = jest.fn();
    const { result, rerender } = renderHook(
      ({ report }) => useAttachmentProcessing(false, report),
      {
        initialProps: { report: first }
      }
    );
    const handler = result.current.onProcessingChange;

    rerender({ report: second });
    act(() => result.current.onProcessingChange(true));

    expect(result.current.onProcessingChange).toBe(handler);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(expect.any(String), true);
  });

  test('reports itself idle when it goes away', () => {
    const report = jest.fn();
    const { result, unmount } = renderHook(() => useAttachmentProcessing(false, report));
    act(() => result.current.onProcessingChange(true));
    const [[id]] = report.mock.calls;

    unmount();

    expect(report).toHaveBeenLastCalledWith(id, false);
  });
});
