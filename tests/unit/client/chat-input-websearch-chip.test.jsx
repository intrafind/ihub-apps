/**
 * The input bar shows when web search is on (issue #2520): a highlighted
 * "Web search" chip next to the "+" menu, which turns it off in one click.
 * The switch itself stays in the menu.
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
jest.mock('../../../client/src/features/chat/components/WorkflowMentionSearch', () => () => null);
jest.mock('../../../client/src/features/chat/components/ChatInputActionsMenu', () => () => (
  <button type="button">+</button>
));
jest.mock('../../../client/src/features/chat/components/ModelHintBanner', () => () => null);
jest.mock('../../../client/src/features/voice/components', () => ({
  VoiceInputComponent: () => null
}));

const app = { id: 'web', websearch: { enabled: true } };
const renderInput = props =>
  render(
    <ChatInput
      app={app}
      value=""
      onChange={() => {}}
      onSubmit={() => {}}
      isProcessing={false}
      showModelSelector={false}
      {...props}
    />
  );

describe('web search chip', () => {
  test('shows while web search is on and turns it off in one click', () => {
    const onWebsearchEnabledChange = jest.fn();
    renderInput({ websearchEnabled: true, onWebsearchEnabledChange });
    const chip = screen.getByRole('button', { name: 'Web search is on — turn it off' });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(chip);
    expect(onWebsearchEnabledChange).toHaveBeenCalledWith(false);
  });

  test('is not shown while web search is off', () => {
    renderInput({ websearchEnabled: false, onWebsearchEnabledChange: jest.fn() });
    expect(screen.queryByRole('button', { name: /Web search is on/ })).not.toBeInTheDocument();
  });

  test('is not shown for an app without web search', () => {
    renderInput({
      app: { id: 'plain' },
      websearchEnabled: true,
      onWebsearchEnabledChange: jest.fn()
    });
    expect(screen.queryByRole('button', { name: /Web search is on/ })).not.toBeInTheDocument();
  });
});
