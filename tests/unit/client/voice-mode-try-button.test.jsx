/**
 * Admin -> Voice Input -> "Try it" (issue #2868): voice mode in a modal over the
 * admin page. The modal is a dialog: named, closed by a click on the backdrop,
 * Esc and the voice view's own End, never taller than the screen, and Tab stays
 * inside it. The voice view is the real one; the hook is a stand-in.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import VoiceModeTryButton from '../../../client/src/features/voice/components/VoiceModeTryButton';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key, defaultOrOptions) =>
      typeof defaultOrOptions === 'string'
        ? defaultOrOptions
        : (defaultOrOptions?.defaultValue ?? key)
  })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));
jest.mock('../../../client/src/features/voice/hooks/useVoiceModeAvailability', () => ({
  __esModule: true,
  default: () => ({}),
  isVoiceModeBrowserSupported: () => true,
  isSpeechChoiceUsable: () => true
}));
const mockEnded = [];
const mockHookInput = { availability: null };
jest.mock('../../../client/src/features/voice/hooks/useVoiceMode', () => {
  const React = require('react');
  const reducer = jest.requireActual('../../../client/src/features/voice/utils/voiceModeReducer');
  return {
    __esModule: true,
    default: ({ availability }) => {
      mockHookInput.availability = availability;
      const [active, setActive] = React.useState(false);
      const noop = () => {};
      return {
        active,
        state: {
          ...reducer.initialVoiceModeState({ listeningStyle: 'push-to-talk' }),
          status: reducer.VOICE_STATUS.LISTENING
        },
        prefs: { listeningStyle: 'push-to-talk', bargeIn: true, captions: true },
        levelRef: { current: 0 },
        toggle: () => setActive(value => !value),
        end: reason => {
          mockEnded.push(reason);
          setActive(false);
        },
        retry: noop,
        interrupt: noop,
        setMuted: noop,
        pushToTalkStart: noop,
        pushToTalkEnd: noop,
        setListeningStyle: noop,
        setBargeIn: noop,
        setCaptions: noop
      };
    }
  };
});

const SPEECH = { defaultService: 'browser', tts: { defaultModelId: 'tts-1' } };

function openDialog() {
  render(<VoiceModeTryButton speech={SPEECH} />);
  const trigger = screen.getByRole('button', { name: 'Try it' });
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
}
const dialog = () => screen.getByRole('dialog', { name: 'Voice mode test' });
const backdrop = () => dialog().parentElement;

beforeEach(() => {
  mockEnded.length = 0;
});

describe('the Try it modal is a dialog', () => {
  test('is named, modal and not open until Try it is pressed', () => {
    render(<VoiceModeTryButton speech={SPEECH} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try it' }));
    expect(dialog()).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByTestId('voice-mode-dock')).toBeInTheDocument();
  });

  test('a click on the backdrop closes it', () => {
    openDialog();
    fireEvent.click(backdrop());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockEnded).toEqual(['user']);
  });

  test('a click inside the card does not', () => {
    openDialog();
    fireEvent.click(dialog());
    fireEvent.click(screen.getByTestId('voice-mode-dock'));
    fireEvent.click(screen.getByTestId('voice-mode-status'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(mockEnded).toEqual([]);
  });

  test('Esc closes it and the focus goes back to the Try it button', () => {
    const trigger = openDialog();
    expect(screen.getByTestId('voice-mode-dock')).toHaveFocus();
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  test('End in the voice view closes it', () => {
    openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'End voice mode (Esc)' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('the card is never taller than the screen', () => {
    // A fixed 32rem card fell off the bottom of a phone in landscape (375 px).
    openDialog();
    expect(dialog().className).toContain('h-[min(32rem,100%)]');
    expect(dialog().className).not.toMatch(/(^|\s)h-\[32rem\]/);
  });
});

describe('Tab stays inside the dialog', () => {
  const tab = (element, options = {}) => fireEvent.keyDown(element, { key: 'Tab', ...options });

  test('Tab on the last control wraps to the first', () => {
    openDialog();
    const last = screen.getByRole('button', { name: 'End voice mode (Esc)' });
    last.focus();
    expect(tab(last)).toBe(false);
    expect(screen.getByRole('button', { name: 'Voice settings' })).toHaveFocus();
  });

  test('Shift+Tab on the first control wraps to the last', () => {
    openDialog();
    const first = screen.getByRole('button', { name: 'Voice settings' });
    first.focus();
    expect(tab(first, { shiftKey: true })).toBe(false);
    expect(screen.getByRole('button', { name: 'End voice mode (Esc)' })).toHaveFocus();
  });

  test('Shift+Tab from the voice view itself, where focus starts, lands on the last control', () => {
    openDialog();
    const root = screen.getByTestId('voice-mode-dock');
    expect(root).toHaveFocus();
    expect(tab(root, { shiftKey: true })).toBe(false);
    expect(screen.getByRole('button', { name: 'End voice mode (Esc)' })).toHaveFocus();
  });

  test('Tab in the middle is left to the browser', () => {
    openDialog();
    const mute = screen.getByRole('button', { name: 'Mute microphone' });
    mute.focus();
    expect(tab(mute)).toBe(true);
    expect(tab(mute, { shiftKey: true })).toBe(true);
  });

  test('other keys are left alone', () => {
    openDialog();
    const last = screen.getByRole('button', { name: 'End voice mode (Esc)' });
    last.focus();
    expect(fireEvent.keyDown(last, { key: 'a' })).toBe(true);
  });
});

describe('the speech settings the voice session is given', () => {
  const azure = (extra = {}) => ({
    defaultService: 'azure',
    tts: { defaultModelId: 'tts-1' },
    azure: { enabled: true, host: '', region: 'westeurope', subscriptionKey: '', ...extra }
  });

  test('Azure with a saved key says so, in the shape the adapter reads, without the key', () => {
    render(<VoiceModeTryButton speech={azure({ subscriptionKey: '***REDACTED***' })} />);
    expect(mockHookInput.availability.platformSpeech.azure).toEqual({
      enabled: true,
      host: '',
      region: 'westeurope',
      keyConfigured: true
    });
    expect(JSON.stringify(mockHookInput.availability)).not.toContain('REDACTED');
  });

  test('a key that was typed is never handed on either', () => {
    render(<VoiceModeTryButton speech={azure({ subscriptionKey: 'sk-secret-typed' })} />);
    expect(JSON.stringify(mockHookInput.availability)).not.toContain('sk-secret-typed');
  });

  test('no key: the adapter is told there is none', () => {
    render(<VoiceModeTryButton speech={azure()} />);
    expect(mockHookInput.availability.platformSpeech.azure.keyConfigured).toBe(false);
  });

  test('a public-shaped section keeps its flag', () => {
    render(<VoiceModeTryButton speech={azure({ keyConfigured: true })} />);
    expect(mockHookInput.availability.platformSpeech.azure.keyConfigured).toBe(true);
  });

  test('the rest of the section is passed on, and a section without Azure does not break', () => {
    render(<VoiceModeTryButton speech={SPEECH} />);
    expect(mockHookInput.availability.platformSpeech).toMatchObject({
      defaultService: 'browser',
      tts: { defaultModelId: 'tts-1' },
      azure: { enabled: false, keyConfigured: false }
    });
  });
});
