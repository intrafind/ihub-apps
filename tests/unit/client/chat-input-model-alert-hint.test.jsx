// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A model with an `alert` hint blocks sending until the user clicks
 * "I Understand" — but not the model selector: picking another model is the
 * way out for a user who does not want the experimental one (#3811).
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
jest.mock('../../../client/src/features/projects/components/ChatProjectChips', () => () => null);
jest.mock('../../../client/src/features/projects/components/ChatProjectPicker', () => ({
  __esModule: true,
  default: () => null,
  useOfferedProjects: () => []
}));
jest.mock('../../../client/src/features/chat/components/ChatInputActionsMenu', () => () => (
  <button type="button">+</button>
));
jest.mock('../../../client/src/features/voice/components', () => ({
  VoiceInputComponent: () => null
}));

// The selector itself is not under test: a stand-in that exposes `disabled`.
jest.mock('../../../client/src/features/chat/components/ModelSelector', () => ({
  __esModule: true,
  default: ({ disabled, onModelChange }) => (
    <select aria-label="Model" disabled={disabled} onChange={e => onModelChange(e.target.value)}>
      <option value="experimental">experimental</option>
      <option value="stable">stable</option>
    </select>
  )
}));

const models = [
  {
    id: 'experimental',
    name: { en: 'Experimental' },
    hint: {
      message: { en: 'EXPERIMENTAL MODEL' },
      level: 'alert',
      dismissible: false
    }
  },
  { id: 'stable', name: { en: 'Stable' } }
];

const renderInput = props =>
  render(
    <ChatInput
      app={{ id: 'chat' }}
      value="hello"
      onChange={() => {}}
      onSubmit={() => {}}
      isProcessing={false}
      showModelSelector={true}
      models={models}
      selectedModel="experimental"
      currentLanguage="en"
      {...props}
    />
  );

describe('alert hint of the selected model (#3811)', () => {
  test('blocks sending until acknowledged, but the model can still be changed', () => {
    const onModelChange = jest.fn();
    renderInput({ onModelChange });

    expect(screen.getByText('EXPERIMENTAL MODEL')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    const selector = screen.getByRole('combobox', { name: 'Model' });
    expect(selector).toBeEnabled();
    fireEvent.change(selector, { target: { value: 'stable' } });
    expect(onModelChange).toHaveBeenCalledWith('stable');
  });

  test('acknowledging the alert enables sending', () => {
    renderInput({ onModelChange: () => {} });

    fireEvent.click(screen.getByRole('button', { name: 'I Understand' }));

    expect(screen.queryByText('EXPERIMENTAL MODEL')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  test('the selector is still locked while a turn runs', () => {
    renderInput({ onModelChange: () => {}, isProcessing: true });

    expect(screen.getByRole('combobox', { name: 'Model' })).toBeDisabled();
  });

  test('a form submit is refused until the alert is acknowledged', () => {
    const onSubmit = jest.fn();
    const { container } = renderInput({ onModelChange: () => {}, onSubmit });

    fireEvent.submit(container.querySelector('form'));
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'I Understand' }));
    fireEvent.submit(container.querySelector('form'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
