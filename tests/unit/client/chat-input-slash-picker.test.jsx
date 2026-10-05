/**
 * The `/` picker of the chat input. A picked skill is not sent any more: it
 * goes into the text as `/<skill-name> ` (the name, also for a personal
 * skill — never its `usk_…` id) and the user keeps typing; the server
 * activates the skills named by `/name` tokens. The picker opens in an empty
 * input (the `/` is not typed) and, new, right after whitespace in a
 * non-empty input (the `/` is typed, so closing the picker leaves it). A
 * picked prompt keeps its behaviour: it becomes the input, or replaces the
 * typed `/` mid-text.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useState } from 'react';
import ChatInput from '../../../client/src/features/chat/components/ChatInput';
import {
  insertAtSlash,
  insertSkillAtSlash,
  opensSlashPickerMidText,
  skillToken,
  typeSlashAt
} from '../../../client/src/features/chat/utils/slashCommand';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key, defaultOrOptions) => (typeof defaultOrOptions === 'string' ? defaultOrOptions : key)
  })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
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
// The picker itself is tested elsewhere; here it only exposes its props.
let mockPickerProps = null;
jest.mock('../../../client/src/features/prompts/components/PromptSearch', () => props => {
  mockPickerProps = props;
  return props.isOpen ? <div data-testid="picker" /> : null;
});
const mockLaunch = jest.fn();
jest.mock('../../../client/src/features/prompts/hooks/usePromptLauncher', () => () => ({
  launch: mockLaunch,
  dialog: null
}));
jest.mock('../../../client/src/features/chat/components/WorkflowMentionSearch', () => () => null);
jest.mock('../../../client/src/features/chat/components/ChatInputActionsMenu', () => () => null);
jest.mock('../../../client/src/features/chat/components/ModelHintBanner', () => () => null);
jest.mock('../../../client/src/features/voice/components', () => ({
  VoiceInputComponent: () => null
}));

const SKILL = { _type: 'skill', id: 'usk_abc', name: 'weekly-report', scope: 'mine' };

function Harness({ initial = '', app = { id: 'chat' }, skillsSlashEnabled = true }) {
  const [value, setValue] = useState(initial);
  return (
    <ChatInput
      app={app}
      value={value}
      onChange={event => setValue(event.target.value)}
      onSubmit={() => {}}
      isProcessing={false}
      showModelSelector={false}
      skillsSlashEnabled={skillsSlashEnabled}
    />
  );
}

const textbox = () => screen.getByRole('textbox');
const typeSlash = () => fireEvent.keyDown(textbox(), { key: '/' });
const placeCaret = at => {
  textbox().focus();
  textbox().setSelectionRange(at, at);
};

beforeEach(() => {
  mockPickerProps = null;
  mockLaunch.mockReset();
});

describe('slash command text helpers', () => {
  test('mid-text, the picker opens at the start of a word only', () => {
    expect(opensSlashPickerMidText('Summarize ', 10, 10)).toBe(true);
    expect(opensSlashPickerMidText('a\nb', 2, 2)).toBe(true);
    expect(opensSlashPickerMidText('text', 0, 0)).toBe(true);
    expect(opensSlashPickerMidText('and', 3, 3)).toBe(false);
    expect(opensSlashPickerMidText('https:', 6, 6)).toBe(false);
    expect(opensSlashPickerMidText('a b', 2, 3)).toBe(false);
    expect(opensSlashPickerMidText('', 0, 0)).toBe(false);
    expect(opensSlashPickerMidText('a ', undefined, undefined)).toBe(false);
  });

  test('typeSlashAt types a slash at the caret', () => {
    expect(typeSlashAt('ab', 1)).toBe('a/b');
  });

  test('a skill token ends in a space unless whitespace follows', () => {
    expect(skillToken('weekly-report')).toBe('/weekly-report ');
    expect(skillToken('weekly-report', ' rest')).toBe('/weekly-report');
    expect(skillToken('weekly-report', 'rest')).toBe('/weekly-report ');
  });

  test('without an anchor the pick becomes the input', () => {
    expect(insertAtSlash('', null, 'Hello {{x}}', 6)).toEqual({ value: 'Hello {{x}}', caret: 6 });
    expect(insertSkillAtSlash('', null, 'weekly-report')).toEqual({
      value: '/weekly-report ',
      caret: 15
    });
  });

  test('with an anchor the pick replaces the typed slash', () => {
    expect(insertSkillAtSlash('Please / thanks', 7, 'weekly-report')).toEqual({
      value: 'Please /weekly-report thanks',
      caret: 21
    });
    expect(insertAtSlash('Do / now', 3, 'this')).toEqual({ value: 'Do this now', caret: 7 });
    // The slash went missing meanwhile: insert at the anchor anyway.
    expect(insertAtSlash('Do  now', 3, 'this')).toEqual({ value: 'Do this now', caret: 7 });
  });
});

describe('ChatInput `/` picker', () => {
  test('passes the skill gating to the picker', () => {
    const { unmount } = render(<Harness skillsSlashEnabled />);
    expect(mockPickerProps.skillsEnabled).toBe(true);
    expect(mockPickerProps.allowPersonalSkills).toBe(true);
    unmount();
    render(
      <Harness
        skillsSlashEnabled={false}
        app={{ id: 'chat', skills: ['a'], skillSettings: { allowPersonal: false } }}
      />
    );
    expect(mockPickerProps.skillsEnabled).toBe(false);
    expect(mockPickerProps.appSkills).toEqual(['a']);
    expect(mockPickerProps.allowPersonalSkills).toBe(false);
  });

  test('in an empty input a picked skill becomes `/<name> `, not a sent message', async () => {
    render(<Harness />);
    typeSlash();
    expect(screen.getByTestId('picker')).toBeInTheDocument();
    expect(textbox()).toHaveValue('');

    await act(async () => {
      await mockPickerProps.onSelect(SKILL);
    });
    expect(screen.queryByTestId('picker')).not.toBeInTheDocument();
    expect(textbox()).toHaveValue('/weekly-report ');
    await waitFor(() => expect(textbox().selectionStart).toBe('/weekly-report '.length));
  });

  test('after whitespace the slash is typed and the skill replaces it', async () => {
    render(<Harness initial="Summarize this " />);
    placeCaret(15);
    typeSlash();
    expect(screen.getByTestId('picker')).toBeInTheDocument();
    expect(textbox()).toHaveValue('Summarize this /');

    await act(async () => {
      await mockPickerProps.onSelect(SKILL);
    });
    expect(textbox()).toHaveValue('Summarize this /weekly-report ');
  });

  test('closing the picker mid-text keeps the slash as typed', async () => {
    render(<Harness initial="1 2" />);
    placeCaret(2);
    typeSlash();
    expect(textbox()).toHaveValue('1 /2');
    act(() => {
      mockPickerProps.onClose();
      // Escape reaches the picker twice; the second close is a no-op.
      mockPickerProps.onClose();
    });
    expect(screen.queryByTestId('picker')).not.toBeInTheDocument();
    expect(textbox()).toHaveValue('1 /2');
    await waitFor(() => expect(textbox().selectionStart).toBe(3));
  });

  test('inside a word `/` is a plain character', () => {
    render(<Harness initial="and" />);
    placeCaret(3);
    const notPrevented = typeSlash();
    expect(notPrevented).toBe(true);
    expect(screen.queryByTestId('picker')).not.toBeInTheDocument();
  });

  test('a picked prompt still becomes the input in an empty input', async () => {
    mockLaunch.mockResolvedValue({ text: 'Translate: ', caret: null });
    render(<Harness />);
    typeSlash();
    await act(async () => {
      await mockPickerProps.onSelect({ _type: 'prompt', id: 'p1', name: 'Translate' });
    });
    expect(textbox()).toHaveValue('Translate: ');
  });

  test('mid-text, a picked prompt replaces the typed slash', async () => {
    mockLaunch.mockResolvedValue({ text: 'in German', caret: null });
    render(<Harness initial="Say hello " />);
    placeCaret(10);
    typeSlash();
    await act(async () => {
      await mockPickerProps.onSelect({ _type: 'prompt', id: 'p1', name: 'German' });
    });
    expect(textbox()).toHaveValue('Say hello in German');
  });

  test('a cancelled prompt leaves the typed slash', async () => {
    mockLaunch.mockResolvedValue(null);
    render(<Harness initial="Say " />);
    placeCaret(4);
    typeSlash();
    let used;
    await act(async () => {
      used = await mockPickerProps.onSelect({ _type: 'prompt', id: 'p1', name: 'X' });
    });
    expect(used).toBe(false);
    expect(textbox()).toHaveValue('Say /');
  });
});
