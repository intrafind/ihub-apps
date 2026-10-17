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

const renderInput = props =>
  render(
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
